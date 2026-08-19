import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ScreenshotService } from '../src/screenshots/screenshotService';
import type { AgentConfigCamera } from '../src/types/agentConfig';
import { silentLogger } from './helpers/fakes';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('frame-bytes')]);

function makeCamera(id = 1, overrides: Partial<AgentConfigCamera> = {}): AgentConfigCamera {
  return {
    id,
    name: `Camera ${id}`,
    rtspUrl: `rtsp://cam${id}:554/stream`,
    channel: `offroad_cam_${id}`,
    uid: `${1000 + id}`,
    rtmpBaseUrl: 'rtmp://rtls-ingress-prod-ap.agoramdn.com/live',
    streamKey: `sk-${id}`,
    rtmpPublishUrl: `rtmp://rtls-ingress-prod-ap.agoramdn.com/live/sk-${id}`,
    streamKeyExpiresAt: new Date().toISOString(),
    video: {
      codec: 'libx264',
      preset: 'veryfast',
      width: 1920,
      height: 1080,
      fps: 25,
      bitrateKbps: 3000,
      maxrateKbps: 3000,
      bufsizeKbps: 6000,
      transcodeEnabled: true,
      rtspTransport: 'tcp',
    },
    audio: { enabled: true, codec: 'aac', bitrateKbps: 160 },
    ...overrides,
  };
}

function fakeChild() {
  const emitter = new EventEmitter();
  const stderr = new EventEmitter() as EventEmitter & { setEncoding(): void };
  stderr.setEncoding = () => {};
  const child = {
    pid: 777,
    // a 'q' on stdin makes ffmpeg exit cleanly (as with the real binary)
    stdin: {
      write: vi.fn(() => {
        setImmediate(() => emitter.emit('exit', 0, null));
        return true;
      }),
    },
    stderr,
    on(ev: string, cb: (...a: unknown[]) => void) {
      emitter.on(ev, cb);
      return child;
    },
    once(ev: string, cb: (...a: unknown[]) => void) {
      emitter.once(ev, cb);
      return child;
    },
    kill(sig?: string) {
      setImmediate(() => emitter.emit('exit', null, sig ?? 'SIGKILL'));
    },
    emitExit: (code: number) => emitter.emit('exit', code, null),
  };
  return child as unknown as {
    stdin: { write: ReturnType<typeof vi.fn> };
    kill(sig?: string): void;
    emitExit(code: number): void;
  };
}

interface Spawned {
  args: string[];
  child: ReturnType<typeof fakeChild>;
}

describe('ScreenshotService (agent)', () => {
  let dir: string;
  let service: ScreenshotService;
  let spawned: Spawned[];
  let uploads: Array<{ cameraId: number; buffer: Buffer }>;
  let upload: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-screenshots-'));
    spawned = [];
    uploads = [];
    upload = vi.fn(async (cameraId: number, buffer: Buffer) => {
      uploads.push({ cameraId, buffer });
    });
    service = new ScreenshotService({
      api: { uploadScreenshot: upload } as never,
      logger: silentLogger,
      ffmpegPath: 'ffmpeg-test',
      dir,
      intervalSeconds: 0.05,
      spawnImpl: ((_path: string, args: string[]) => {
        const child = fakeChild();
        spawned.push({ args, child });
        return child;
      }) as never,
    });
    await service.ensureDir();
    service.startUploadLoop();
  });

  afterEach(async () => {
    await service.stopAll();
  });

  const writeFrame = async (cameraId: number, data: Buffer) => {
    const file = path.join(dir, `${cameraId}.jpg`);
    await fs.writeFile(file, data);
    await fs.utimes(file, new Date(), new Date(Date.now() + 1000)); // force a newer mtime
  };

  const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

  it('starts a JPEG capture process (fps=1 -update 1), not a video stream', async () => {
    await service.start(makeCamera(1));
    expect(spawned).toHaveLength(1);
    const args = spawned[0]!.args;
    expect(args).toContain('-vf');
    expect(args).toContain('fps=1');
    expect(args).toContain('-update');
    expect(args[args.indexOf('-update')! + 1]).toBe('1');
    expect(args).toContain(path.join(dir, '1.jpg'));
  });

  it('uploads the latest frame at the configured interval, not at video rate', async () => {
    await service.start(makeCamera(1));
    await writeFrame(1, JPEG);
    await settle();
    expect(uploads.length).toBeGreaterThanOrEqual(1);
    expect(uploads[0]!.cameraId).toBe(1);
    expect(uploads[0]!.buffer).toEqual(JPEG);
  });

  it('does not re-upload an unchanged frame', async () => {
    await service.start(makeCamera(1));
    await writeFrame(1, JPEG);
    await settle();
    const first = uploads.length;
    expect(first).toBeGreaterThanOrEqual(1);
    await settle();
    expect(uploads.length).toBe(first);
  });

  it('skips non-JPEG files', async () => {
    await service.start(makeCamera(1));
    await writeFrame(1, Buffer.from('not an image'));
    await settle();
    expect(uploads).toHaveLength(0);
  });

  it('swallows upload errors when the backend is unreachable', async () => {
    upload.mockRejectedValue(new Error('connection refused'));
    await service.start(makeCamera(1));
    await writeFrame(1, JPEG);
    await settle();
    expect(uploads).toHaveLength(0); // failure logged, nothing thrown
  });

  it('restarts a dead capture process on the next upload cycle', async () => {
    await service.start(makeCamera(1));
    expect(spawned).toHaveLength(1);
    const inner = service as unknown as {
      procs: Map<number, { running: boolean; camera: AgentConfigCamera }>;
    };
    inner.procs.get(1)!.running = false; // capture process died
    await settle();
    expect(spawned.length).toBeGreaterThanOrEqual(2); // restarted by the loop
  });

  it('stop() sends q for a clean exit', async () => {
    await service.start(makeCamera(1));
    await service.stop(1);
    expect(spawned[0]!.child.stdin.write).toHaveBeenCalledWith('q');
  });

  it('stopAll clears the upload timer so nothing else is uploaded', async () => {
    await service.start(makeCamera(1));
    await service.stopAll();
    await writeFrame(1, JPEG);
    await settle();
    expect(uploads).toHaveLength(0);
  });

  it('restarts the capture process when the RTSP transport changes', async () => {
    await service.start(makeCamera(1));
    await service.start(makeCamera(1, { video: { ...makeCamera(1).video, rtspTransport: 'udp' } }));
    expect(spawned).toHaveLength(2);
  });

  it('does not restart when the camera config is identical', async () => {
    await service.start(makeCamera(1));
    await service.start(makeCamera(1));
    expect(spawned).toHaveLength(1);
  });
});