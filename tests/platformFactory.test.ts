import { describe, it, expect } from 'vitest';
import { createPlatformService, detectPlatform, WindowsPlatformService, MacOSPlatformService } from '../src/platform';

const OPTS = { rootDir: '/app/agent', scriptPath: '/app/agent/dist/index.js' };

describe('createPlatformService', () => {
  it('returns the Windows implementation for win32', () => {
    expect(createPlatformService('win32', OPTS)).toBeInstanceOf(WindowsPlatformService);
  });

  it('returns the macOS implementation for darwin', () => {
    expect(createPlatformService('darwin', OPTS)).toBeInstanceOf(MacOSPlatformService);
  });

  it('throws for unsupported platforms', () => {
    expect(() => createPlatformService('linux', OPTS)).toThrow(/unsupported platform/);
    expect(() => createPlatformService('freebsd', OPTS)).toThrow(/unsupported platform/);
  });

  it('detectPlatform maps the running OS', () => {
    expect(['windows', 'macos', 'linux']).toContain(detectPlatform());
  });
});