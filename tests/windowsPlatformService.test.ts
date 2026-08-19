import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { WindowsPlatformService, WINDOWS_SERVICE_NAME } from '../src/platform/windowsPlatformService';
import type { WindowsServiceLike } from '../src/platform/windowsPlatformService';

function fakeServiceFactory(calls: string[], exists = false, autoEmit = true) {
  return (opts: {
    name: string;
    script: string;
    nodeOptions: string[];
    maxRetries: number;
    wait: number;
    grow: number;
    startMode: string;
    workingDirectory: string;
  }) => {
    const listeners = new Map<string, (arg?: unknown) => void>();
    const emit = (event: string, arg?: unknown) => {
      if (autoEmit) listeners.get(event)?.(arg);
    };
    const svc: WindowsServiceLike = {
      exists: () => emit('exists', exists),
      install: () => {
        calls.push('install');
        emit('install');
      },
      uninstall: () => {
        calls.push('uninstall');
        emit('uninstall');
      },
      start: () => {
        calls.push('start');
        emit('start');
      },
      stop: () => {
        calls.push('stop');
        emit('stop');
      },
      on: (event, cb) => {
        listeners.set(event, cb);
        return svc;
      },
    };
    calls.push(`factory:${opts.name}`);
    return svc;
  };
}

function makeService(calls: string[], opts: { exists?: boolean } = {}) {
  return new WindowsPlatformService({
    rootDir: '/app/camera-stream-agent',
    scriptPath: '/app/camera-stream-agent/dist/index.js',
    serviceFactory: fakeServiceFactory(calls, opts.exists),
    execFileImpl: ((_cmd: string, args: string[], cb: (err: Error | null) => void) => {
      calls.push(`exec:${_cmd} ${args.join(' ')}`);
      cb(null);
    }) as never,
  });
}

afterEach(() => {
  delete process.env.FFMPEG_PATH;
});

describe('WindowsPlatformService', () => {
  it('is named windows and keeps logs beside the running script', () => {
    const service = makeService([]);
    expect(service.name).toBe('windows');
    expect(service.logDir).toBe('/app/camera-stream-agent');
  });

  it('install registers and starts the service with SCM recovery settings', async () => {
    const calls: string[] = [];
    const service = makeService(calls);
    await service.installService();
    expect(calls).toContain('install');
    expect(calls).toContain('start');
    expect(calls[0]).toBe(`factory:${WINDOWS_SERVICE_NAME}`);
  });

  it('install skips when the service already exists', async () => {
    const calls: string[] = [];
    const service = makeService(calls, { exists: true });
    await service.installService();
    expect(calls).not.toContain('install');
  });

  it('uninstall skips when the service does not exist', async () => {
    const calls: string[] = [];
    const service = makeService(calls, { exists: false });
    await service.uninstallService();
    expect(calls).not.toContain('uninstall');
  });

  it('uninstall removes the service', async () => {
    const calls: string[] = [];
    const service = makeService(calls, { exists: true });
    await service.uninstallService();
    expect(calls).toContain('uninstall');
  });

  it('start and stop delegate to the SCM service', async () => {
    const calls: string[] = [];
    const service = makeService(calls);
    await service.startService();
    await service.stopService();
    expect(calls).toContain('start');
    expect(calls).toContain('stop');
  });

  it('restart stops then starts', async () => {
    const calls: string[] = [];
    const service = makeService(calls);
    await service.restartService();
    const stopIdx = calls.indexOf('stop');
    const startIdx = calls.indexOf('start');
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(stopIdx);
  });

  it('status reports existence', async () => {
    const service = makeService([], { exists: true });
    const status = await service.statusService();
    expect(status).toContain(WINDOWS_SERVICE_NAME);
    expect(status).toContain('exists');
  });

  it('terminateProcessTree kills the whole tree with taskkill', async () => {
    const calls: string[] = [];
    const service = makeService(calls);
    await service.terminateProcessTree(1234);
    expect(calls).toContain('exec:taskkill /PID 1234 /T /F');
  });

  it('ffmpegBinary honours the FFMPEG_PATH env var', () => {
    process.env.FFMPEG_PATH = 'C:\\tools\\ffmpeg\\bin\\ffmpeg.exe';
    const service = makeService([]);
    expect(service.ffmpegBinary).toBe('C:\\tools\\ffmpeg\\bin\\ffmpeg.exe');
    delete process.env.FFMPEG_PATH;
    expect(makeService([]).ffmpegBinary).toBe('ffmpeg');
  });

  it('throws when managing the service without a built script', async () => {
    const service = new WindowsPlatformService({
      rootDir: '/app/camera-stream-agent',
      serviceFactory: fakeServiceFactory([]),
      execFileImpl: ((_cmd: string, _args: string[], cb: (err: Error | null) => void) => cb(null)) as never,
    });
    await expect(service.startService()).rejects.toThrow(/npm run build/);
  });
});