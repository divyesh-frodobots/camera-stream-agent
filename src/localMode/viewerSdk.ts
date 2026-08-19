import fs from 'node:fs';
import path from 'node:path';

const BUNDLE = path.join('node_modules', 'agora-rtc-sdk-ng', 'AgoraRTC_N-production.js');

/**
 * Locates the Agora Web SDK bundle installed under the agent folder so the
 * viewer can serve it from localhost instead of a CDN.
 */
export function resolveSdkBundle(
  rootDir: string,
  exists: (filePath: string) => boolean = fs.existsSync,
): string | null {
  const candidate = path.join(rootDir, BUNDLE);
  return exists(candidate) ? candidate : null;
}
