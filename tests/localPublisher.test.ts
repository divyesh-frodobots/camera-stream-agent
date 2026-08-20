import { describe, expect, it } from 'vitest';
import {
  emptyCamerasFile,
  type StoredCamera,
  type StoredCamerasFile,
} from '../src/localMode/camerasFile';
import { CamerasStore } from '../src/localMode/camerasStore';
import { LocalPublisher } from '../src/localMode/localPublisher';
import { CameraProcessManager, type CameraProcessState } from '../src/ffmpeg/CameraProcessManager';
import type { AgentConfigCamera, CameraRuntimeStatus } from '../src/types/agentConfig';
import { maskRtmpUrl, maskUrl } from '../src/utils/mask';
import { silentLogger } from './helpers/fakes';

function copyFile(file: StoredCamerasFile): StoredCamerasFile {
  return structuredClone(file);
}

function configured(
  id: number,
  overrides: Partial<StoredCamera> = {},
): StoredCamera {
  return {
    id,
    name: `Camera ${id}`,
    rtspUrl: `rtsp://user:password-${id}@camera-${id}/live`,
    rtmpPublishUrl: `rtmps://publish.example/live/stream-key-${id}`,
    enabled: false,
    ...overrides,
  };
}

class MemoryStore {
  file: StoredCamerasFile;
  invalidMessage: string | null;
  saved: StoredCamerasFile[] = [];
  saveDelayMs = 0;
  readonly events: string[];

  constructor(
    file = emptyCamerasFile(),
    invalidMessage: string | null = null,
    events: string[] = [],
  ) {
    this.file = copyFile(file);
    this.invalidMessage = invalidMessage;
    this.events = events;
  }

  async load() {
    return { file: copyFile(this.file), invalidMessage: this.invalidMessage };
  }

  async save(file: StoredCamerasFile) {
    this.events.push('save');
    if (this.saveDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.saveDelayMs));
    }
    this.file = copyFile(file);
    this.saved.push(copyFile(file));
  }
}

class FakePm {
  started: number[] = [];
  stopped: number[] = [];
  restarted: number[] = [];
  forgotten: number[] = [];
  states = new Map<
    number,
    { status: CameraRuntimeStatus; lastError: string | null; pid: number | null }
  >();
  startFailures = new Map<number, number>();
  stopFailures = new Map<number, number>();
  restartFailures = new Map<number, number>();
  forgetFailures = new Map<number, number>();

  constructor(readonly events: string[] = []) {}

  async start(cam: AgentConfigCamera) {
    this.started.push(cam.id);
    this.events.push(`start:${cam.id}`);
    if (this.consumeFailure(this.startFailures, cam.id)) {
      throw new Error(`start ${cam.id} failed`);
    }
    this.states.set(cam.id, {
      status: 'STREAMING',
      lastError: null,
      pid: 10 + cam.id,
    });
  }

  async stop(id: number) {
    this.stopped.push(id);
    this.events.push(`stop:${id}`);
    if (this.consumeFailure(this.stopFailures, id)) {
      throw new Error(`stop ${id} failed`);
    }
    this.states.set(id, { status: 'STOPPED', lastError: null, pid: null });
  }

  async forget(id: number) {
    this.forgotten.push(id);
    this.events.push(`forget:${id}`);
    if (this.consumeFailure(this.forgetFailures, id)) {
      throw new Error(`forget ${id} failed`);
    }
    this.states.set(id, { status: 'STOPPED', lastError: null, pid: null });
  }

  async forceRestart(cam: AgentConfigCamera) {
    this.restarted.push(cam.id);
    this.events.push(`restart:${cam.id}`);
    if (this.consumeFailure(this.restartFailures, cam.id)) {
      throw new Error(`restart ${cam.id} failed`);
    }
    this.states.set(cam.id, {
      status: 'STREAMING',
      lastError: null,
      pid: 10 + cam.id,
    });
  }

  private consumeFailure(failures: Map<number, number>, id: number): boolean {
    const remaining = failures.get(id) ?? 0;
    if (remaining <= 0) return false;
    failures.set(id, remaining - 1);
    return true;
  }

  getState(id: number): CameraProcessState {
    const state = this.states.get(id);
    return {
      cameraId: id,
      cameraName: '',
      status: state?.status ?? 'STOPPED',
      pid: state?.pid ?? null,
      uptime: 0,
      restartCount: 0,
      lastError: state?.lastError ?? null,
      lastErrorCategory: null,
      lastOutput: null,
      startedAt: null,
      lastHealthyAt: null,
      progress: { frame: 0, fps: 0, bitrateKbps: 0 },
    };
  }
}

function publisher(store: MemoryStore, pm = new FakePm()) {
  return {
    localPublisher: new LocalPublisher({
      store: store as unknown as CamerasStore,
      processManager: pm as unknown as CameraProcessManager,
      logger: silentLogger,
    }),
    pm,
  };
}

function sixRows(
  patches: Partial<Record<number, Partial<StoredCamera>>>,
): Array<Partial<StoredCamera> & { id: number }> {
  return Array.from({ length: 6 }, (_, index) => {
    const id = index + 1;
    return { id, ...patches[id] };
  });
}

describe('LocalPublisher', () => {
  it('loads and snapshots exactly six masked rows with mapped process state', async () => {
    const file = emptyCamerasFile();
    file.cameras[0] = configured(1);
    const store = new MemoryStore(file);
    const { localPublisher, pm } = publisher(store);
    pm.states.set(1, {
      status: 'RECONNECTING',
      pid: 41,
      lastError:
        'failed rtsp://user:password-1@camera-1/live while publishing rtmps://publish.example/live/stream-key-1; password-1 stream-key-1',
    });

    await localPublisher.load();
    const snapshot = localPublisher.snapshot();
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.cameras).toHaveLength(6);
    expect(snapshot.cameras[0]).toMatchObject({
      id: 1,
      configured: true,
      state: 'Reconnecting',
      pid: 41,
    });
    expect(snapshot.cameras[1]).toMatchObject({
      id: 2,
      configured: false,
      state: 'Not configured',
    });
    expect(serialized).not.toContain('password-1');
    expect(serialized).not.toContain('stream-key-1');
    expect(snapshot.ffmpegError).toBe(snapshot.cameras[0]!.lastError);
  });

  it('replaces raw URLs in lastError with maskUrl and maskRtmpUrl', async () => {
    const rtsp = 'rtsp://user:password-1@camera-1/live';
    const rtmp = 'rtmps://publish.example/live/stream-key-1';
    const file = emptyCamerasFile();
    file.cameras[0] = configured(1, { rtspUrl: rtsp, rtmpPublishUrl: rtmp });
    const store = new MemoryStore(file);
    const { localPublisher, pm } = publisher(store);
    pm.states.set(1, {
      status: 'ERROR',
      pid: null,
      lastError: `failed ${rtsp} while publishing ${rtmp}`,
    });

    await localPublisher.load();
    const error = localPublisher.snapshot().cameras[0]!.lastError!;

    expect(error).toContain(maskUrl(rtsp));
    expect(error).toContain(maskRtmpUrl(rtmp));
    expect(error).not.toContain(rtsp);
    expect(error).not.toContain(rtmp);
    expect(error).not.toContain('password-1');
    expect(error).not.toContain('stream-key-1');
  });

  it('returns 404 for start, stop, and restart of an unknown id', async () => {
    const store = new MemoryStore();
    const { localPublisher, pm } = publisher(store);
    await localPublisher.load();

    await expect(localPublisher.start(7)).resolves.toEqual({
      ok: false,
      status: 404,
      message: expect.any(String),
    });
    await expect(localPublisher.stop(7)).resolves.toEqual({
      ok: false,
      status: 404,
      message: expect.any(String),
    });
    await expect(localPublisher.restart(7)).resolves.toEqual({
      ok: false,
      status: 404,
      message: expect.any(String),
    });
    expect(store.saved).toHaveLength(0);
    expect(pm.started).toEqual([]);
    expect(pm.stopped).toEqual([]);
    expect(pm.restarted).toEqual([]);
  });

  it('fully redacts adversarial URL secrets from lastError', async () => {
    const file = emptyCamerasFile();
    const rtsp =
      'rtsp://rtsp%2Duser:rtsp%2Dpassword@camera/live?auth=rtsp%2Dtoken#rtsp%2Dfragment';
    const rtmp =
      'rtmps://rtmp%2Duser:rtmp%2Dpassword@publish/live/stream%2Dkey?token=query%2Dtoken#rtmp%2Dfragment';
    file.cameras[0] = configured(1, { rtspUrl: rtsp, rtmpPublishUrl: rtmp });
    const store = new MemoryStore(file);
    const { localPublisher, pm } = publisher(store);
    const secrets = [
      rtsp,
      rtmp,
      'rtsp%2Duser',
      'rtsp-user',
      'rtsp%2Dpassword',
      'rtsp-password',
      'rtsp%2Dtoken',
      'rtsp-token',
      'rtsp%2Dfragment',
      'rtsp-fragment',
      'rtmp%2Duser',
      'rtmp-user',
      'rtmp%2Dpassword',
      'rtmp-password',
      'stream%2Dkey',
      'stream-key',
      'query%2Dtoken',
      'query-token',
      'rtmp%2Dfragment',
      'rtmp-fragment',
    ];
    pm.states.set(1, {
      status: 'ERROR',
      pid: null,
      lastError: `URLs ${rtsp} ${rtmp}; standalone ${secrets.slice(2).join(' ')}`,
    });

    await localPublisher.load();
    const error = localPublisher.snapshot().cameras[0]!.lastError!;

    for (const secret of secrets) {
      expect(error).not.toContain(secret);
    }
  });

  it('uses a generic error instead of replacing a common query value', async () => {
    const file = emptyCamerasFile();
    file.cameras[0] = configured(1, {
      rtspUrl: 'rtsp://long-user:long-password@camera/live?secure=true',
    });
    const store = new MemoryStore(file);
    const { localPublisher, pm } = publisher(store);
    pm.states.set(1, {
      status: 'ERROR',
      pid: null,
      lastError: 'authentication was true before connection failed',
    });

    await localPublisher.load();

    expect(localPublisher.snapshot().cameras[0]!.lastError).toBe(
      'FFmpeg error (sensitive details redacted)',
    );
  });

  it('keeps an empty in-memory file and invalid message when load is invalid', async () => {
    const file = emptyCamerasFile();
    file.cameras[0] = configured(1, { enabled: true });
    const store = new MemoryStore(file, 'bad cameras json');
    const { localPublisher, pm } = publisher(store);

    expect(await localPublisher.load()).toEqual({ invalidMessage: 'bad cameras json' });
    expect(localPublisher.snapshot().cameras.every((row) => !row.configured)).toBe(true);
    await localPublisher.startEnabledOnBoot();
    expect(pm.started).toEqual([]);
  });

  it('returns 409 and does not persist when starting an unconfigured row', async () => {
    const store = new MemoryStore();
    const { localPublisher, pm } = publisher(store);
    await localPublisher.load();

    await expect(localPublisher.start(1)).resolves.toEqual({
      ok: false,
      status: 409,
      message: expect.any(String),
    });
    expect(store.saved).toHaveLength(0);
    expect(pm.started).toEqual([]);
  });

  it('persists enabled before starting a configured row', async () => {
    const file = emptyCamerasFile();
    file.cameras[0] = configured(1);
    const store = new MemoryStore(file);
    const { localPublisher, pm } = publisher(store);
    await localPublisher.load();

    await expect(localPublisher.start(1)).resolves.toEqual({ ok: true });
    expect(store.file.cameras[0]!.enabled).toBe(true);
    expect(pm.started).toEqual([1]);
  });

  it('stops and restarts only the requested camera and persists enabled state', async () => {
    const file = emptyCamerasFile();
    file.cameras[0] = configured(1, { enabled: true });
    file.cameras[1] = configured(2, { enabled: true });
    const store = new MemoryStore(file);
    const { localPublisher, pm } = publisher(store);
    await localPublisher.load();

    await localPublisher.stop(1);
    expect(pm.stopped).toEqual([1]);
    expect(store.file.cameras[0]!.enabled).toBe(false);
    expect(store.file.cameras[1]!.enabled).toBe(true);

    await localPublisher.restart(2);
    expect(pm.restarted).toEqual([2]);
    expect(store.file.cameras[1]!.enabled).toBe(true);
  });

  it('save restarts only changed running cameras and leaves unchanged streams up', async () => {
    const file = emptyCamerasFile();
    file.cameras[0] = configured(1);
    file.cameras[1] = configured(2);
    const store = new MemoryStore(file);
    const { localPublisher, pm } = publisher(store);
    await localPublisher.load();
    await pm.start({ id: 1 } as AgentConfigCamera);
    await pm.start({ id: 2 } as AgentConfigCamera);
    pm.started = [];

    const result = await localPublisher.save(
      sixRows({ 2: { rtspUrl: 'rtsp://user:new-password@camera-2/live' } }),
    );

    expect(result.ok).toBe(true);
    expect(pm.restarted).toEqual([2]);
    expect(pm.started).toEqual([]);
    expect(pm.stopped).toEqual([]);
  });

  it('retries only a failed camera when the same desired config is saved again', async () => {
    const file = emptyCamerasFile();
    file.cameras[0] = configured(1);
    file.cameras[1] = configured(2);
    const store = new MemoryStore(file);
    const { localPublisher, pm } = publisher(store);
    await localPublisher.load();
    await pm.start({ id: 1 } as AgentConfigCamera);
    await pm.start({ id: 2 } as AgentConfigCamera);
    pm.started = [];
    pm.events.length = 0;
    pm.restartFailures.set(1, 1);
    const incoming = sixRows({
      1: { rtspUrl: 'rtsp://camera-1/new' },
      2: { rtspUrl: 'rtsp://camera-2/new' },
    });

    await expect(localPublisher.save(incoming)).rejects.toThrow(/camera 1/i);
    expect(pm.restarted).toEqual([1, 2]);

    await expect(localPublisher.save(incoming)).resolves.toMatchObject({ ok: true });
    expect(pm.restarted).toEqual([1, 2, 1]);
  });

  it('save forgets a running camera when both URLs are cleared', async () => {
    const file = emptyCamerasFile();
    file.cameras[0] = configured(1);
    const store = new MemoryStore(file);
    const { localPublisher, pm } = publisher(store);
    await localPublisher.load();
    await pm.start({ id: 1 } as AgentConfigCamera);

    const result = await localPublisher.save(
      sixRows({ 1: { rtspUrl: '', rtmpPublishUrl: '' } }),
    );

    expect(result.ok).toBe(true);
    expect(pm.forgotten).toEqual([1]);
  });

  it('does not persist or mutate processes when save validation fails', async () => {
    const file = emptyCamerasFile();
    file.cameras[0] = configured(1);
    const store = new MemoryStore(file);
    const { localPublisher, pm } = publisher(store);
    await localPublisher.load();

    const result = await localPublisher.save(sixRows({ 1: { rtspUrl: 'http://bad' } }));

    expect(result.ok).toBe(false);
    expect(store.saved).toHaveLength(0);
    expect(pm.started).toEqual([]);
    expect(pm.restarted).toEqual([]);
  });

  it('startAll starts configured rows only and stopAll stops only running rows', async () => {
    const file = emptyCamerasFile();
    file.cameras[0] = configured(1);
    file.cameras[2] = configured(3);
    const store = new MemoryStore(file);
    const { localPublisher, pm } = publisher(store);
    await localPublisher.load();

    await localPublisher.startAll();
    expect(pm.started).toEqual([1, 3]);
    expect(store.file.cameras[0]!.enabled).toBe(true);
    expect(store.file.cameras[2]!.enabled).toBe(true);

    await localPublisher.stopAll();
    expect(pm.stopped).toEqual([1, 3]);
    expect(store.file.cameras.every((camera) => !camera.enabled)).toBe(true);
  });

  it('startAll persists first and continues after one camera fails', async () => {
    const file = emptyCamerasFile();
    file.cameras[0] = configured(1);
    file.cameras[1] = configured(2);
    const events: string[] = [];
    const store = new MemoryStore(file, null, events);
    const pm = new FakePm(events);
    const { localPublisher } = publisher(store, pm);
    await localPublisher.load();
    pm.startFailures.set(1, 1);

    await expect(localPublisher.startAll()).rejects.toThrow(/camera 1/i);

    expect(events).toEqual(['save', 'start:1', 'start:2']);
    expect(store.file.cameras[0]!.enabled).toBe(true);
    expect(store.file.cameras[1]!.enabled).toBe(true);
    expect(pm.states.get(2)?.status).toBe('STREAMING');
  });

  it('stopAll continues after one camera fails and records successful rows', async () => {
    const file = emptyCamerasFile();
    file.cameras[0] = configured(1, { enabled: true });
    file.cameras[1] = configured(2, { enabled: true });
    const events: string[] = [];
    const store = new MemoryStore(file, null, events);
    const pm = new FakePm(events);
    const { localPublisher } = publisher(store, pm);
    await localPublisher.load();
    await pm.start({ id: 1 } as AgentConfigCamera);
    await pm.start({ id: 2 } as AgentConfigCamera);
    events.length = 0;
    pm.stopFailures.set(1, 1);

    await expect(localPublisher.stopAll()).rejects.toThrow(/camera 1/i);

    expect(events).toEqual(['save', 'stop:1', 'stop:2']);
    expect(pm.states.get(1)?.status).toBe('STREAMING');
    expect(pm.states.get(2)?.status).toBe('STOPPED');
  });

  it('starts only configured enabled rows on boot', async () => {
    const file = emptyCamerasFile();
    file.cameras[0] = configured(1, { enabled: true });
    file.cameras[1] = configured(2, { enabled: false });
    const store = new MemoryStore(file);
    const { localPublisher, pm } = publisher(store);
    await localPublisher.load();

    await localPublisher.startEnabledOnBoot();

    expect(pm.started).toEqual([1]);
  });

  it('boot start continues after one enabled camera fails', async () => {
    const file = emptyCamerasFile();
    file.cameras[0] = configured(1, { enabled: true });
    file.cameras[1] = configured(2, { enabled: true });
    const store = new MemoryStore(file);
    const { localPublisher, pm } = publisher(store);
    await localPublisher.load();
    pm.startFailures.set(1, 1);

    await expect(localPublisher.startEnabledOnBoot()).rejects.toThrow(/camera 1/i);

    expect(pm.started).toEqual([1, 2]);
    expect(pm.states.get(2)?.status).toBe('STREAMING');
  });

  it('serializes concurrent read-modify-write operations so enabled updates are not lost', async () => {
    const file = emptyCamerasFile();
    file.cameras[0] = configured(1);
    file.cameras[1] = configured(2);
    const store = new MemoryStore(file);
    store.saveDelayMs = 10;
    const { localPublisher } = publisher(store);
    await localPublisher.load();

    await Promise.all([localPublisher.start(1), localPublisher.start(2)]);

    expect(store.file.cameras[0]!.enabled).toBe(true);
    expect(store.file.cameras[1]!.enabled).toBe(true);
  });
});
