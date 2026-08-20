import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { CameraProcessManager, ProcessTerminationError, StopAllIncompleteError, type CameraProcessState } from '../src/ffmpeg/CameraProcessManager';
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
  emitClose(): void;
  sendProgress(line: string): void;
  sendError(line: string): void;
}

interface FakeChildOptions {
  closeDelayMs?: number;
  neverClose?: boolean;
  exitWithoutClose?: boolean;
  ignoreKill?: boolean;
  pid?: number;
}

function fakeChild(opts: FakeChildOptions = {}): FakeChild {
  const exit = new EventEmitter();
  const stdout = new EventEmitter() as EventEmitter & { setEncoding(): void };
  const stderr = new EventEmitter() as EventEmitter & { setEncoding(): void };
  stdout.setEncoding = () => {};
  stderr.setEncoding = () => {};
  const state = {
    exitCode: null as number | null,
    signalCode: null as string | null,
    killed: false,
  };

  const emitExit = () => {
    exit.emit('exit', 1, null);
    exit.emit('close', 1, null);
  };

  const scheduleExit = () => {
    if (opts.neverClose || opts.exitWithoutClose || opts.ignoreKill) return;
    if (opts.closeDelayMs && opts.closeDelayMs > 0) {
      setTimeout(emitExit, opts.closeDelayMs);
      return;
    }
    setImmediate(emitExit);
  };

  const child = {
    pid: opts.pid ?? 4242,
    get exitCode() {
      return state.exitCode;
    },
    get signalCode() {
      return state.signalCode;
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
    kill(_signal?: string) {
      state.killed = true;
      if (opts.ignoreKill) return;
      state.exitCode = 1;
      scheduleExit();
    },
    crash() {
      state.exitCode = 1;
      scheduleExit();
    },
    emitClose() {
      state.exitCode = 1;
      emitExit();
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

async function drainManager(manager: CameraProcessManager, ms = 80): Promise<void> {
  try {
    await manager.stopAll();
  } catch {
    /* stopAll may reject when termination stays unconfirmed */
  }
  await new Promise((r) => setTimeout(r, ms));
}

describe('CameraProcessManager', () => {
  let spawned: Array<{ args: string[]; child: FakeChild }>;
  let manager: CameraProcessManager;
  let nextPid: number;

  beforeEach(() => {
    env.FFMPEG_KILL_TIMEOUT_MS = 50;
    env.FFMPEG_START_TIMEOUT_MS = 60000;
    env.FFMPEG_HEALTH_TIMEOUT_SECONDS = 45;
    env.RESTART_BASE_DELAY_SECONDS = 5;
    env.RESTART_MAX_DELAY_SECONDS = 60;
    spawned = [];
    nextPid = 5000;
    manager = new CameraProcessManager({
      ffmpegPath: 'ffmpeg-test',
      logger: silentLogger,
      spawnImpl: ((_path: string, args: string[], _opts: unknown) => {
        const child = fakeChild({ pid: nextPid++ });
        spawned.push({ args, child });
        return child;
      }) as never,
    });
  });

  afterEach(async () => {
    await drainManager(manager, 120);
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

  it('forceRestart stops a running process, resets backoff, and spawns with new config', async () => {
    await manager.start(makeCamera(1));
    spawned[0]!.child.sendProgress('frame=1\nprogress=continue\n');
    expect(manager.getState(1)!.status).toBe('STREAMING');

    const updated = makeCamera(1);
    updated.rtspUrl = 'rtsp://cam1:554/new-stream';

    await manager.forceRestart(updated);

    expect(spawned).toHaveLength(2);
    expect(spawned[0]!.child.killed).toBe(true);
    expect(spawned[1]!.args).toEqual(buildFfmpegArgs(updated));
    expect(manager.getState(1)!.restartCount).toBe(0);
    expect(manager.getState(1)!.status).toBe('STARTING');

    await manager.stop(1, 'test done');
    await new Promise((r) => setTimeout(r, 30));
  });

  it('forceRestart cancels a pending auto-restart and spawns immediately', async () => {
    env.RESTART_BASE_DELAY_SECONDS = 0.5;
    env.RESTART_MAX_DELAY_SECONDS = 1;
    await manager.start(makeCamera(1));
    spawned[0]!.child.crash();
    await new Promise((r) => setTimeout(r, 20));
    expect(manager.getState(1)!.restartCount).toBeGreaterThan(0);
    expect(spawned).toHaveLength(1);

    const updated = makeCamera(1);
    updated.rtspUrl = 'rtsp://cam1:554/forced';
    await manager.forceRestart(updated);

    const countAfterForce = spawned.length;
    expect(countAfterForce).toBe(2);
    expect(spawned[1]!.args).toEqual(buildFfmpegArgs(updated));
    expect(manager.getState(1)!.restartCount).toBe(0);
    expect(manager.getState(1)!.pid).toBe(spawned[1]!.child.pid);

    await new Promise((r) => setTimeout(r, 650));
    expect(spawned).toHaveLength(countAfterForce);
    expect(manager.getState(1)!.pid).toBe(spawned[1]!.child.pid);
    await manager.stop(1, 'test done');
    await new Promise((r) => setTimeout(r, 30));
  });

  it('forceRestart resets restartCount after consecutive crashes', async () => {
    env.RESTART_BASE_DELAY_SECONDS = 0.05;
    env.RESTART_MAX_DELAY_SECONDS = 0.1;
    await manager.start(makeCamera(1));
    spawned[0]!.child.crash();
    await new Promise((r) => setTimeout(r, 150));
    expect(manager.getState(1)!.restartCount).toBe(1);

    spawned[1]!.child.crash();
    await new Promise((r) => setTimeout(r, 150));
    expect(manager.getState(1)!.restartCount).toBe(2);

    await manager.forceRestart(makeCamera(1));
    expect(manager.getState(1)!.restartCount).toBe(0);

    await manager.stopAll();
    await new Promise((r) => setTimeout(r, 150));
  });

  it('forceRestart keeps the replacement when the old child close is delayed', async () => {
    env.FFMPEG_KILL_TIMEOUT_MS = 200;
    spawned.length = 0;
    manager = new CameraProcessManager({
      ffmpegPath: 'ffmpeg-test',
      logger: silentLogger,
      spawnImpl: ((_path: string, args: string[], _opts: unknown) => {
        const child = fakeChild({ pid: nextPid++, closeDelayMs: spawned.length === 0 ? 120 : 0 });
        spawned.push({ args, child });
        return child;
      }) as never,
    });

    await manager.start(makeCamera(1));
    spawned[0]!.child.sendProgress('frame=1\nprogress=continue\n');

    const updated = makeCamera(1);
    updated.rtspUrl = 'rtsp://cam1:554/delayed-close';
    await manager.forceRestart(updated);

    expect(spawned).toHaveLength(2);
    expect(manager.getState(1)!.pid).toBe(spawned[1]!.child.pid);
    expect(spawned[1]!.args).toEqual(buildFfmpegArgs(updated));

    await new Promise((r) => setTimeout(r, 200));
    expect(manager.getState(1)!.pid).toBe(spawned[1]!.child.pid);
    expect(spawned).toHaveLength(2);

    await manager.stop(1, 'test done');
    await new Promise((r) => setTimeout(r, 150));
  });

  it('serializes concurrent forceRestart calls so only the last replacement stays live', async () => {
    await manager.start(makeCamera(1));
    spawned[0]!.child.sendProgress('frame=1\nprogress=continue\n');

    const first = makeCamera(1);
    first.rtspUrl = 'rtsp://cam1:554/concurrent-a';
    const second = makeCamera(1);
    second.rtspUrl = 'rtsp://cam1:554/concurrent-b';

    await Promise.all([manager.forceRestart(first), manager.forceRestart(second)]);

    expect(spawned.length).toBeGreaterThanOrEqual(2);
    const live = manager.getState(1)!;
    expect(live.pid).not.toBeNull();
    expect(live.pid).toBe(spawned[spawned.length - 1]!.child.pid);
    expect(spawned[spawned.length - 1]!.args).toEqual(buildFfmpegArgs(second));

    const liveChildren = spawned.filter((s) => s.child.pid === live.pid);
    expect(liveChildren).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 120));
    expect(manager.getState(1)!.pid).toBe(live.pid);
    expect(spawned[spawned.length - 1]!.args).toEqual(buildFfmpegArgs(second));

    await manager.stop(1, 'test done');
    await new Promise((r) => setTimeout(r, 30));
  });

  it('queues start after forceRestart without orphaning the replacement', async () => {
    await manager.start(makeCamera(1));
    spawned[0]!.child.sendProgress('frame=1\nprogress=continue\n');

    const updated = makeCamera(1);
    updated.rtspUrl = 'rtsp://cam1:554/queued-restart';

    await Promise.all([manager.forceRestart(updated), manager.start(makeCamera(1))]);

    expect(spawned).toHaveLength(2);
    expect(manager.getState(1)!.pid).toBe(spawned[1]!.child.pid);
    expect(spawned[1]!.args).toEqual(buildFfmpegArgs(updated));

    await new Promise((r) => setTimeout(r, 120));
    expect(manager.getState(1)!.pid).toBe(spawned[1]!.child.pid);
    expect(spawned).toHaveLength(2);

    await manager.stop(1, 'test done');
    await new Promise((r) => setTimeout(r, 30));
  });

  it('stop after a queued forceRestart leaves no post-stop spawn', async () => {
    env.RESTART_BASE_DELAY_SECONDS = 0.5;
    env.RESTART_MAX_DELAY_SECONDS = 1;
    await manager.start(makeCamera(1));
    spawned[0]!.child.sendProgress('frame=1\nprogress=continue\n');

    const updated = makeCamera(1);
    updated.rtspUrl = 'rtsp://cam1:554/stop-after-restart';

    const restartPromise = manager.forceRestart(updated);
    const stopPromise = manager.stop(1, 'stop after queued restart');
    await Promise.all([restartPromise, stopPromise]);

    const countAfterStop = spawned.length;
    expect(manager.getState(1)!.status).toBe('STOPPED');
    expect(manager.getState(1)!.pid).toBeNull();

    await new Promise((r) => setTimeout(r, 650));
    expect(spawned).toHaveLength(countAfterStop);
    expect(manager.getState(1)!.status).toBe('STOPPED');
  });

  it('stopAll cancels pending restart timers and prevents post-shutdown spawns', async () => {
    env.RESTART_BASE_DELAY_SECONDS = 0.5;
    env.RESTART_MAX_DELAY_SECONDS = 1;
    await manager.start(makeCamera(1));
    spawned[0]!.child.crash();
    await new Promise((r) => setTimeout(r, 20));

    await manager.stopAll();
    const countAfterStopAll = spawned.length;

    await new Promise((r) => setTimeout(r, 650));
    expect(spawned).toHaveLength(countAfterStopAll);
    expect(manager.getAllStates()).toHaveLength(0);
  });

  it('finalizes stop when the child exited but never emitted close', async () => {
    env.FFMPEG_KILL_TIMEOUT_MS = 25;
    spawned.length = 0;
    manager = new CameraProcessManager({
      ffmpegPath: 'ffmpeg-test',
      logger: silentLogger,
      spawnImpl: ((_path: string, args: string[], _opts: unknown) => {
        const child = fakeChild({ pid: nextPid++, exitWithoutClose: true });
        spawned.push({ args, child });
        return child;
      }) as never,
    });

    await manager.start(makeCamera(1));
    const startedAt = Date.now();
    await manager.stop(1, 'exit without close event');
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(250);
    expect(manager.getState(1)!.status).toBe('STOPPED');
    expect(manager.getState(1)!.pid).toBeNull();
    expect(spawned).toHaveLength(1);
  });

  it('rejects stop within bounded time when kill is ignored and termination stays unconfirmed', async () => {
    env.FFMPEG_KILL_TIMEOUT_MS = 25;
    spawned.length = 0;
    manager = new CameraProcessManager({
      ffmpegPath: 'ffmpeg-test',
      logger: silentLogger,
      spawnImpl: ((_path: string, args: string[], _opts: unknown) => {
        const child = fakeChild({ pid: nextPid++, ignoreKill: true });
        spawned.push({ args, child });
        return child;
      }) as never,
    });

    await manager.start(makeCamera(1));
    const startedAt = Date.now();
    await expect(manager.stop(1, 'unkillable child')).rejects.toBeInstanceOf(ProcessTerminationError);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(250);
    expect(spawned).toHaveLength(1);
    expect(manager.getState(1)!.status).toBe('ERROR');
    expect(manager.getState(1)!.pid).toBe(spawned[0]!.child.pid);
    expect(manager.getState(1)!.lastError).toContain('termination unconfirmed');
  });

  it('forceRestart does not spawn when termination stays unconfirmed', async () => {
    env.FFMPEG_KILL_TIMEOUT_MS = 25;
    spawned.length = 0;
    manager = new CameraProcessManager({
      ffmpegPath: 'ffmpeg-test',
      logger: silentLogger,
      spawnImpl: ((_path: string, args: string[], _opts: unknown) => {
        const child = fakeChild({ pid: nextPid++, ignoreKill: true });
        spawned.push({ args, child });
        return child;
      }) as never,
    });

    await manager.start(makeCamera(1));
    spawned[0]!.child.sendProgress('frame=1\nprogress=continue\n');

    const updated = makeCamera(1);
    updated.rtspUrl = 'rtsp://cam1:554/no-restart-on-failure';

    await expect(manager.forceRestart(updated)).rejects.toBeInstanceOf(ProcessTerminationError);
    expect(spawned).toHaveLength(1);
    expect(manager.getState(1)!.status).toBe('ERROR');
    expect(manager.getState(1)!.pid).toBe(spawned[0]!.child.pid);
  });

  it('stopAll rejects without infinite loop when termination stays unconfirmed', async () => {
    env.FFMPEG_KILL_TIMEOUT_MS = 25;
    spawned.length = 0;
    manager = new CameraProcessManager({
      ffmpegPath: 'ffmpeg-test',
      logger: silentLogger,
      spawnImpl: ((_path: string, args: string[], _opts: unknown) => {
        const child = fakeChild({ pid: nextPid++, ignoreKill: true });
        spawned.push({ args, child });
        return child;
      }) as never,
    });

    await manager.start(makeCamera(1));
    const startedAt = Date.now();
    await expect(manager.stopAll()).rejects.toBeInstanceOf(StopAllIncompleteError);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(250);
    expect(spawned).toHaveLength(1);
    expect(manager.getState(1)!.status).toBe('ERROR');
    expect(manager.getState(1)!.pid).toBe(spawned[0]!.child.pid);
    expect(manager.getAllStates()).toHaveLength(1);
  });

  it('stopAll stops other cameras when one lifecycle op rejected', async () => {
    env.FFMPEG_KILL_TIMEOUT_MS = 25;
    spawned.length = 0;
    manager = new CameraProcessManager({
      ffmpegPath: 'ffmpeg-test',
      logger: silentLogger,
      spawnImpl: ((_path: string, args: string[], _opts: unknown) => {
        const ignoreKill = args.join(' ').includes('rtsp://cam1:554/stream');
        const child = fakeChild({ pid: nextPid++, ignoreKill });
        spawned.push({ args, child });
        return child;
      }) as never,
    });

    await manager.start(makeCamera(1));
    await manager.start(makeCamera(2));

    const updated = makeCamera(1);
    updated.rtspUrl = 'rtsp://cam1:554/failed-restart';
    await expect(manager.forceRestart(updated)).rejects.toBeInstanceOf(ProcessTerminationError);
    expect(manager.getState(1)!.status).toBe('ERROR');

    const err = await manager.stopAll().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StopAllIncompleteError);
    expect((err as StopAllIncompleteError).stuckCameraIds).toContain(1);
    expect(manager.getState(2)!.status).toBe('STOPPED');
    expect(manager.getState(2)!.pid).toBeNull();
  });

  it('start timeout on unkillable child does not cause unhandled rejection', async () => {
    env.FFMPEG_START_TIMEOUT_MS = 30;
    env.FFMPEG_KILL_TIMEOUT_MS = 25;
    env.FFMPEG_HEALTH_TIMEOUT_SECONDS = 3600;
    spawned.length = 0;
    manager = new CameraProcessManager({
      ffmpegPath: 'ffmpeg-test',
      logger: silentLogger,
      spawnImpl: ((_path: string, args: string[], _opts: unknown) => {
        const child = fakeChild({ pid: nextPid++, ignoreKill: true });
        spawned.push({ args, child });
        return child;
      }) as never,
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      await manager.start(makeCamera(1));
      await new Promise((r) => setTimeout(r, 120));
      expect(unhandled).toHaveLength(0);
      expect(manager.getState(1)!.status).toBe('ERROR');
      expect(manager.getState(1)!.lastError).toContain('termination unconfirmed');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('retries forceRestart after unconfirmed kill once the child actually closes', async () => {
    env.FFMPEG_KILL_TIMEOUT_MS = 25;
    spawned.length = 0;
    manager = new CameraProcessManager({
      ffmpegPath: 'ffmpeg-test',
      logger: silentLogger,
      spawnImpl: ((_path: string, args: string[], _opts: unknown) => {
        const ignoreKill = spawned.length === 0;
        const child = fakeChild({ pid: nextPid++, ignoreKill });
        spawned.push({ args, child });
        return child;
      }) as never,
    });

    await manager.start(makeCamera(1));
    spawned[0]!.child.sendProgress('frame=1\nprogress=continue\n');

    const firstTry = makeCamera(1);
    firstTry.rtspUrl = 'rtsp://cam1:554/retry-a';
    await expect(manager.forceRestart(firstTry)).rejects.toBeInstanceOf(ProcessTerminationError);
    expect(spawned).toHaveLength(1);
    expect(manager.getState(1)!.status).toBe('ERROR');
    expect(manager.getState(1)!.pid).toBe(spawned[0]!.child.pid);

    const secondTry = makeCamera(1);
    secondTry.rtspUrl = 'rtsp://cam1:554/retry-b';
    await expect(manager.forceRestart(secondTry)).rejects.toBeInstanceOf(ProcessTerminationError);
    expect(spawned).toHaveLength(1);
    expect(manager.getState(1)!.pid).toBe(spawned[0]!.child.pid);

    spawned[0]!.child.emitClose();
    await new Promise((r) => setTimeout(r, 10));

    const thirdTry = makeCamera(1);
    thirdTry.rtspUrl = 'rtsp://cam1:554/retry-c';
    await manager.forceRestart(thirdTry);

    expect(spawned).toHaveLength(2);
    expect(spawned[1]!.args).toEqual(buildFfmpegArgs(thirdTry));
    expect(manager.getState(1)!.pid).toBe(spawned[1]!.child.pid);
    expect(manager.getState(1)!.status).toBe('STARTING');

    await manager.stop(1, 'test done');
    await new Promise((r) => setTimeout(r, 30));
  });
});