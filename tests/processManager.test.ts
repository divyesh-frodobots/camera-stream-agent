import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { CameraProcessManager, type CameraProcessState } from '../src/ffmpeg/CameraProcessManager';
import { buildFfmpegArgs } from '../src/ffmpeg/ffmpegArgs';
import { env } from '../src/config/env';
import { silentLogger } from './helpers/fakes';
import type { AgentConfigCamera } from '../src/types/agentConfig';

function makeCamera(id = 1): AgentConfigCamera {
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
  };
}

interface FakeChild {
  pid: number;
  exitCode: number | null;
  killed: boolean;
  exit: EventEmitter;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill(): void;
  crash(): void;
  sendProgress(line: string): void;
  sendError(line: string): void;
}

function fakeChild(): FakeChild {
  const exit = new EventEmitter();
  const stdout = new EventEmitter() as EventEmitter & { setEncoding(): void };
  const stderr = new EventEmitter() as EventEmitter & { setEncoding(): void };
  stdout.setEncoding = () => {};
  stderr.setEncoding = () => {};
  const state = { exitCode: null as number | null, killed: false };

  const child = {
    pid: 4242,
    get exitCode() {
      return state.exitCode;
    },
    get killed() {
      return state.killed;
    },
    stdin: { write: () => true },
    stdout,
    stderr,
    on(ev: string, cb: (...a: unknown[]) => void) {
      if (ev === 'exit' || ev === 'close') exit.on(ev, cb);
      return child;
    },
    once(ev: string, cb: (...a: unknown[]) => void) {
      if (ev === 'exit' || ev === 'close') exit.once(ev, cb);
      return child;
    },
    kill() {
      state.killed = true;
      state.exitCode = 1;
      setImmediate(() => exit.emit('exit', 1, null));
      setImmediate(() => exit.emit('close', 1, null));
    },
    crash() {
      state.exitCode = 1;
      setImmediate(() => exit.emit('close', 1, null));
    },
    sendProgress(line: string) {
      stdout.emit('data', line);
    },
    sendError(line: string) {
      stderr.emit('data', line);
    },
  };

  child.on('exit', () => {});
  child.on('close', () => {});
  return child as unknown as FakeChild;
}

describe('CameraProcessManager', () => {
  let spawned: Array<{ args: string[]; child: FakeChild }>;
  let manager: CameraProcessManager;

  beforeEach(() => {
    env.FFMPEG_KILL_TIMEOUT_MS = 50;
    env.FFMPEG_START_TIMEOUT_MS = 60000;
    env.FFMPEG_HEALTH_TIMEOUT_SECONDS = 45;
    env.RESTART_BASE_DELAY_SECONDS = 5;
    env.RESTART_MAX_DELAY_SECONDS = 60;
    spawned = [];
    manager = new CameraProcessManager({
      ffmpegPath: 'ffmpeg-test',
      logger: silentLogger,
      spawnImpl: ((_path: string, args: string[], _opts: unknown) => {
        const child = fakeChild();
        spawned.push({ args, child });
        return child;
      }) as never,
    });
  });

  it('spawns FFmpeg with the built argument array', async () => {
    await manager.start(makeCamera(1));
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args).toEqual(buildFfmpegArgs(makeCamera(1)));
    expect(manager.getState(1)!.status).toBe('STARTING');
  });

  it('does not double-spawn a running camera', async () => {
    await manager.start(makeCamera(1));
    await manager.start(makeCamera(1));
    expect(spawned).toHaveLength(1);
  });

  it('restarts with backoff after a crash', async () => {
    env.RESTART_BASE_DELAY_SECONDS = 0.05;
    env.RESTART_MAX_DELAY_SECONDS = 0.1;
    await manager.start(makeCamera(1));
    spawned[0]!.child.crash();
    await new Promise((r) => setTimeout(r, 250));
    expect(spawned.length).toBeGreaterThanOrEqual(2);
    expect(manager.getState(1)!.restartCount).toBeGreaterThan(0);
  });

  it('marks stream STREAMING when progress arrives', async () => {
    await manager.start(makeCamera(1));
    const child = spawned[0]!.child;
    child.sendProgress('frame=1\nfps=25\nbitrate=3000.0\nprogress=continue\n');
    expect(manager.getState(1)!.status).toBe('STREAMING');
    expect(manager.getState(1)!.progress.frame).toBe(1);
    expect(manager.getState(1)!.progress.bitrateKbps).toBe(3000);
  });

  it('reports RECONNECTING after an RTSP error while starting', async () => {
    await manager.start(makeCamera(1));
    spawned[0]!.child.sendError('rtsp://192.168.1.64:554: Connection timed out');
    expect(manager.getState(1)!.status).toBe('RECONNECTING');
    expect(manager.getState(1)!.lastError).toContain('Connection timed out');
  });

  it('kills ffmpeg that never produces its first frame within the startup timeout', async () => {
    env.FFMPEG_START_TIMEOUT_MS = 30;
    env.FFMPEG_HEALTH_TIMEOUT_SECONDS = 3600; // disable the stall check; only the start timer may fire
    env.RESTART_BASE_DELAY_SECONDS = 0.05;
    env.RESTART_MAX_DELAY_SECONDS = 0.1;
    await manager.start(makeCamera(1));

    // no progress is ever emitted on stdout
    await new Promise((r) => setTimeout(r, 40));
    expect(manager.getState(1)!.status).toBe('RECONNECTING');
    expect(manager.getState(1)!.lastError).toContain('did not start');

    // the kill triggered an exit and the backoff loop respawned FFmpeg
    await new Promise((r) => setTimeout(r, 150));
    expect(spawned.length).toBeGreaterThanOrEqual(2);
    expect(manager.getState(1)!.restartCount).toBeGreaterThan(0);

    // stop the camera so the auto-restart loop does not leak into later tests
    await manager.stop(1, 'test done');
    await new Promise((r) => setTimeout(r, 30));
  });

  it('stop cancels a pending restart scheduled by backoff', async () => {
    env.RESTART_BASE_DELAY_SECONDS = 0.05;
    env.RESTART_MAX_DELAY_SECONDS = 0.1;
    await manager.start(makeCamera(1));
    spawned[0]!.child.crash();
    await new Promise((r) => setTimeout(r, 10)); // exit settles, restart scheduled
    await manager.stop(1, 'stop before backoff elapses');
    await new Promise((r) => setTimeout(r, 120));
    expect(spawned).toHaveLength(1); // no respawn after stop
    expect(manager.getState(1)!.status).toBe('STOPPED');
  });

  it('kills and restarts a stream that stalls (no frames within the health timeout)', async () => {
    env.FFMPEG_HEALTH_TIMEOUT_SECONDS = 0.04;
    env.FFMPEG_START_TIMEOUT_MS = 60000; // only the stall check may fire
    env.RESTART_BASE_DELAY_SECONDS = 0.05;
    env.RESTART_MAX_DELAY_SECONDS = 0.1;
    const states: CameraProcessState[] = [];
    manager.onStateChange((s) => states.push(s));
    await manager.start(makeCamera(1));
    spawned[0]!.child.sendProgress('frame=10\nfps=25\nprogress=continue\n'); // healthy once
    expect(manager.getState(1)!.status).toBe('STREAMING');

    // no further progress: the stall check kills ffmpeg, then backoff respawns it
    await new Promise((r) => setTimeout(r, 250));
    expect(spawned.length).toBeGreaterThanOrEqual(2);
    expect(manager.getState(1)!.restartCount).toBeGreaterThan(0);
    expect(states.some((s) => s.lastError?.includes('stalled'))).toBe(true);

    await manager.stopAll();
    await new Promise((r) => setTimeout(r, 150)); // drain the restart loop
  });

  it('restarts ONLY the camera whose ffmpeg died, leaving the other running', async () => {
    env.RESTART_BASE_DELAY_SECONDS = 0.05;
    env.RESTART_MAX_DELAY_SECONDS = 0.1;
    await manager.start(makeCamera(1));
    await manager.start(makeCamera(2));
    spawned[0]!.child.sendProgress('frame=1\nprogress=continue\n');
    spawned[1]!.child.sendProgress('frame=1\nprogress=continue\n');

    spawned[1]!.child.crash(); // only camera 2 dies
    await new Promise((r) => setTimeout(r, 150));

    const cam1 = spawned.filter((s) => s.args.join(' ').includes('rtsp://cam1:554/stream'));
    const cam2 = spawned.filter((s) => s.args.join(' ').includes('rtsp://cam2:554/stream'));
    expect(cam1).toHaveLength(1); // untouched
    expect(cam2.length).toBeGreaterThanOrEqual(2); // restarted
    expect(manager.getState(2)!.restartCount).toBe(1);
    expect(manager.getState(1)!.restartCount).toBe(0);

    await manager.stopAll();
    await new Promise((r) => setTimeout(r, 150));
  });

  it('escalates the backoff across consecutive crashes', async () => {
    env.RESTART_BASE_DELAY_SECONDS = 0.05;
    env.RESTART_MAX_DELAY_SECONDS = 0.1;
    await manager.start(makeCamera(1));
    spawned[0]!.child.crash();
    await new Promise((r) => setTimeout(r, 150));
    expect(manager.getState(1)!.restartCount).toBe(1);

    spawned[1]!.child.crash(); // second failure: attempt counter grows
    await new Promise((r) => setTimeout(r, 150));
    expect(manager.getState(1)!.restartCount).toBe(2);

    await manager.stop(1, 'test done');
    await new Promise((r) => setTimeout(r, 30));
  });

  it('resets the backoff after a healthy period, so a later crash counts from 1 again', async () => {
    env.RESTART_BASE_DELAY_SECONDS = 0.05;
    env.RESTART_MAX_DELAY_SECONDS = 0.1;
    env.HEALTHY_RESET_SECONDS = 0.05;
    await manager.start(makeCamera(1));
    spawned[0]!.child.crash();
    await new Promise((r) => setTimeout(r, 150)); // respawned, restartCount 1

    spawned[1]!.child.sendProgress('frame=1\nprogress=continue\n'); // healthy
    await new Promise((r) => setTimeout(r, 80)); // outlives HEALTHY_RESET_SECONDS
    spawned[1]!.child.sendProgress('frame=2\nprogress=continue\n'); // triggers reset

    spawned[1]!.child.crash();
    await new Promise((r) => setTimeout(r, 150));
    expect(manager.getState(1)!.restartCount).toBe(1); // backoff was reset

    await manager.stopAll();
    await new Promise((r) => setTimeout(r, 150));
  });

  it('stops cleanly without auto-restart', async () => {
    await manager.start(makeCamera(1));
    await manager.stop(1, 'test stop');
    await new Promise((r) => setTimeout(r, 30)); // let the exit event settle
    expect(manager.getState(1)!.status).toBe('STOPPED');
    await new Promise((r) => setTimeout(r, 100));
    expect(spawned).toHaveLength(1); // no restart
  });

  it('stops all processes cleanly', async () => {
    await manager.start(makeCamera(1));
    await manager.start(makeCamera(2));
    await manager.stopAll();
    await new Promise((r) => setTimeout(r, 30));
    expect(manager.getAllStates()).toHaveLength(0);
  });
});