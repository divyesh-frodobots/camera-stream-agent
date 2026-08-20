import { describe, it, expect } from 'vitest';
import { maskRtmpUrl } from '../src/utils/mask';

describe('maskRtmpUrl', () => {
  it('redacts the stream-key path segment', () => {
    expect(maskRtmpUrl('rtmp://rtls-ingress-prod-na.agoramdn.com/live/PGOEF_secretKEY')).toBe(
      'rtmp://rtls-ingress-prod-na.agoramdn.com/live/***tKEY',
    );
  });

  it('returns <none> for empty', () => {
    expect(maskRtmpUrl('')).toBe('<none>');
  });

  it('masks URL credentials and final pathname segment, ignoring query slashes', () => {
    const masked = maskRtmpUrl('rtmp://user:pass@host/live/secretKEY?trace=/foo');
    expect(masked).not.toContain('user');
    expect(masked).not.toContain('pass');
    expect(masked).not.toContain('secretKEY');
    expect(masked).not.toContain('/foo');
    expect(masked).toContain('***tKEY');
    expect(masked).toMatch(/live\/\*\*\*tKEY/);
    expect(masked).toMatch(/trace=.*REDACTED/);
  });

  it('redacts query parameter values and removes fragment', () => {
    const masked = maskRtmpUrl('rtmp://host/live/secretKEY?token=supersecret&foo=bar#fragmentsecret');
    expect(masked).not.toContain('supersecret');
    expect(masked).not.toContain('bar');
    expect(masked).not.toContain('fragmentsecret');
    expect(masked).not.toContain('#');
    expect(masked).toMatch(/token=.*REDACTED/);
    expect(masked).toMatch(/foo=.*REDACTED/);
    expect(masked).toContain('***tKEY');
  });
});
