import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveSdkBundle } from '../src/localMode/viewerSdk';

const ROOT = '/agent';
const INSTALLED = path.join(ROOT, 'node_modules', 'agora-rtc-sdk-ng', 'AgoraRTC_N-production.js');

describe('resolveSdkBundle', () => {
  it('returns the installed SDK bundle path', () => {
    const result = resolveSdkBundle(ROOT, (p) => p === INSTALLED);
    expect(result).toBe(INSTALLED);
  });

  it('returns null when the SDK is not installed', () => {
    expect(resolveSdkBundle(ROOT, () => false)).toBeNull();
  });
});
