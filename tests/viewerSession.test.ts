import { describe, it, expect } from 'vitest';
import { readViewerSessionFromEnv } from '../src/localMode/viewerSession';

describe('readViewerSessionFromEnv', () => {
  it('returns a session when all fields are present and unexpired', () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const result = readViewerSessionFromEnv({
      AGORA_APP_ID: 'app-id',
      AGORA_CHANNEL: 'offroad_cam_1',
      AGORA_RTC_TOKEN: '007token',
      AGORA_RTC_TOKEN_EXPIRES_AT: expiresAt,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.appId).toBe('app-id');
    expect(result.session.channel).toBe('offroad_cam_1');
    expect(result.session.uid).toBe(0);
    expect(result.session.token).toBe('007token');
    expect(result.session.expiresAt).toBe(expiresAt);
  });

  it('fails when the token is missing', () => {
    const result = readViewerSessionFromEnv({
      AGORA_APP_ID: 'app-id',
      AGORA_CHANNEL: 'ch',
      AGORA_RTC_TOKEN: '',
      AGORA_RTC_TOKEN_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/pull-local-config/);
  });

  it('fails when the token is expired', () => {
    const result = readViewerSessionFromEnv({
      AGORA_APP_ID: 'app-id',
      AGORA_CHANNEL: 'ch',
      AGORA_RTC_TOKEN: '007token',
      AGORA_RTC_TOKEN_EXPIRES_AT: new Date(Date.now() - 1000).toISOString(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/expired/);
    expect(result.message).toMatch(/pull-local-config/);
  });
});
