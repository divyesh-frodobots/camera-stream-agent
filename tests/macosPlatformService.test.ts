import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildLaunchdPlist, MacOSPlatformService, LAUNCHD_LABEL, PLIST_NAME } from '../src/platform/macosPlatformService';

let tmpDir: string;
let OPTS: { rootDir: string; scriptPath: string; plistDir: string };

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'macos-platform-test-'));
  OPTS = {
    rootDir: path.join(tmpDir, 'agent'),
    scriptPath: path.join(tmpDir, 'agent', 'dist', 'index.js'),
    plistDir: path.join(tmpDir, 'plists'),
  };
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('buildLaunchdPlist', () => {
  const OPTS2 = {
    label: LAUNCHD_LABEL,
    nodePath: '/usr/local/bin/node',
    scriptPath: '/app/camera-stream-agent/dist/index.js',
    workingDirectory: '/app/camera-stream-agent',
    logDir: '/app/camera-stream-agent/logs',
  };

  it('runs at load and keeps alive on crash', () => {
    const plist = buildLaunchdPlist(OPTS2);
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<true/>');
    expect(plist).toContain('<key>KeepAlive</key>');
  });

  it('points ProgramArguments at node + dist/index.js', () => {
    const plist = buildLaunchdPlist(OPTS2);
    expect(plist).toContain(`<string>${OPTS2.nodePath}</string>`);
    expect(plist).toContain(`<string>${OPTS2.scriptPath}</string>`);
  });

  it('sets working directory and log files', () => {
    const plist = buildLaunchdPlist(OPTS2);
    expect(plist).toContain(`<string>${OPTS2.workingDirectory}</string>`);
    expect(plist).toContain('<key>StandardOutPath</key>');
    expect(plist).toContain('<string>/app/camera-stream-agent/logs/camera-stream-agent.out.log</string>');
    expect(plist).toContain('<key>StandardErrorPath</key>');
    expect(plist).toContain('<string>/app/camera-stream-agent/logs/camera-stream-agent.err.log</string>');
  });
});

describe('MacOSPlatformService', () => {
  function makeService(calls: string[], loaded = false) {
    const execFileImpl = (_cmd: string, args: string[], cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
      calls.push(args.join(' '));
      if (loaded && args[0] === 'print' && args[1] === `system/${LAUNCHD_LABEL}`) {
        cb(null, 'state = running', '');
      } else if (args[0] === 'print') {
        cb(new Error('service not found'), '', '');
      } else {
        cb(null, 'ok', '');
      }
    };
    return new MacOSPlatformService({
      ...OPTS,
      execFileImpl: execFileImpl as never,
    });
  }

  it('is named macos and derives logs from the root dir', () => {
    const service = makeService([]);
    expect(service.name).toBe('macos');
    expect(service.logDir).toBe(path.join(OPTS.rootDir, 'logs'));
  });

  it('install writes the plist and bootstraps', async () => {
    const calls: string[] = [];
    const service = makeService(calls);
    await service.installService();
    const plist = await fs.readFile(path.join(OPTS.plistDir, PLIST_NAME), 'utf8');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain(`<string>${OPTS.scriptPath}</string>`);
    expect(calls.join('\n')).toContain(`bootstrap system ${path.join(OPTS.plistDir, PLIST_NAME)}`);
  });

  it('start bootstraps when not loaded', async () => {
    const calls: string[] = [];
    const service = makeService(calls);
    await service.startService();
    expect(calls).toContain(`bootstrap system ${path.join(OPTS.plistDir, PLIST_NAME)}`);
  });

  it('start kickstarts when already loaded', async () => {
    const calls: string[] = [];
    const service = makeService(calls, true);
    await service.startService();
    expect(calls).toContain(`kickstart system/${LAUNCHD_LABEL}`);
  });

  it('restart uses kickstart -k', async () => {
    const calls: string[] = [];
    const service = makeService(calls, true);
    await service.restartService();
    expect(calls).toContain(`kickstart -k system/${LAUNCHD_LABEL}`);
  });

  it('stop boots out the service', async () => {
    const calls: string[] = [];
    const service = makeService(calls);
    await service.stopService();
    expect(calls).toContain(`bootout system/${LAUNCHD_LABEL}`);
  });

  it('status returns not-loaded message when print fails', async () => {
    const execFileImpl = (_cmd: string, _args: string[], cb: (err: Error | null, stdout?: string, stderr?: string) => void) =>
      cb(new Error('nope'), '', '');
    const service = new MacOSPlatformService({
      ...OPTS,
      execFileImpl: execFileImpl as never,
    });
    const status = await service.statusService();
    expect(status).toContain('not loaded');
  });

  it('terminateProcessTree is a plain SIGKILL that never throws', async () => {
    const service = makeService([]);
    await expect(service.terminateProcessTree(999_999_999)).resolves.toBeUndefined();
  });

  it('throws when managing the service without a built script', async () => {
    const service = new MacOSPlatformService({
      rootDir: OPTS.rootDir,
      execFileImpl: ((_cmd: string, _args: string[], cb: (err: Error | null) => void) => cb(new Error('never'))) as never,
    });
    await expect(service.installService()).rejects.toThrow(/npm run build/);
  });
});