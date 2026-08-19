import { describe, it, expect } from 'vitest';
import { upsertEnvVars } from '../src/localMode/envFile';

describe('upsertEnvVars', () => {
  it('replaces existing keys and keeps unrelated lines', () => {
    const input = ['NODE_ENV=production', 'STREAM_URL=', 'AGENT_API_KEY=ag_keep', ''].join('\n');
    const out = upsertEnvVars(input, {
      STREAM_URL: 'rtsp://user:pw@cam:554/live',
      AGORA_CHANNEL: 'offroad_cam_1',
    });
    expect(out).toContain('NODE_ENV=production');
    expect(out).toContain('AGENT_API_KEY=ag_keep');
    expect(out).toMatch(/^STREAM_URL=/m);
    expect(out).toContain('rtsp://user:pw@cam:554/live');
    expect(out).toMatch(/^AGORA_CHANNEL=/m);
    expect(out).toContain('offroad_cam_1');
    expect(out.split('\n').filter((l) => l.startsWith('STREAM_URL='))).toHaveLength(1);
  });

  it('creates content when the file is empty', () => {
    const out = upsertEnvVars('', { AGORA_APP_ID: 'abc' });
    expect(out).toMatch(/^AGORA_APP_ID=/m);
    expect(out).toContain('abc');
  });
});
