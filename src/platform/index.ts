import { MacOSPlatformService } from './macosPlatformService';
import { WindowsPlatformService } from './windowsPlatformService';
import type { PlatformName, PlatformService, PlatformServiceOptions } from './types';

export type { PlatformName, PlatformService, PlatformServiceOptions } from './types';
export { CommonPlatformService } from './commonPlatformService';
export { MacOSPlatformService, LAUNCHD_LABEL, PLIST_NAME, PLIST_DIR, buildLaunchdPlist, detectNodePath } from './macosPlatformService';
export { WindowsPlatformService, WINDOWS_SERVICE_NAME } from './windowsPlatformService';

/**
 * Maps a Node.js `process.platform` value to our platform abstraction.
 * Throws on unsupported platforms so the agent never silently runs with the
 * wrong service mechanism.
 */
export function createPlatformService(platform: NodeJS.Platform, opts: PlatformServiceOptions): PlatformService {
  switch (platform) {
    case 'win32':
      return new WindowsPlatformService(opts);
    case 'darwin':
      return new MacOSPlatformService(opts);
    default:
      throw new Error(
        `unsupported platform "${platform}": the Camera Agent supports Windows (win32) and macOS (darwin)`,
      );
  }
}

export function detectPlatform(): PlatformName {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    default:
      return 'linux';
  }
}
