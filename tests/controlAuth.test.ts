import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_NONCE_HEADER,
  assertControlRequest,
} from '../src/control/controlAuth';

const PORT = 3456;
const NONCE = 'control-nonce-test-value';

function req(method: string, headers: Record<string, string> = {}): IncomingMessage {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return { method, headers: normalized } as IncomingMessage;
}

describe('CONTROL_NONCE_HEADER', () => {
  it('is the lowercase x-control-nonce header name', () => {
    expect(CONTROL_NONCE_HEADER).toBe('x-control-nonce');
  });
});

describe('assertControlRequest', () => {
  it('rejects mutating requests without a nonce', () => {
    const result = assertControlRequest(req('PUT', { host: `127.0.0.1:${PORT}` }), {
      nonce: NONCE,
      port: PORT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
  });

  it('rejects a foreign Origin even when the nonce matches', () => {
    const result = assertControlRequest(
      req('PUT', {
        host: `127.0.0.1:${PORT}`,
        origin: 'http://evil.example',
        [CONTROL_NONCE_HEADER]: NONCE,
      }),
      { nonce: NONCE, port: PORT },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
  });

  it('allows a loopback Host with a matching nonce', () => {
    const result = assertControlRequest(
      req('PUT', {
        host: `127.0.0.1:${PORT}`,
        [CONTROL_NONCE_HEADER]: NONCE,
      }),
      { nonce: NONCE, port: PORT },
    );
    expect(result).toEqual({ ok: true });
  });

  it('allows GET without a nonce', () => {
    const result = assertControlRequest(req('GET', { host: `127.0.0.1:${PORT}` }), {
      nonce: NONCE,
      port: PORT,
    });
    expect(result).toEqual({ ok: true });
  });

  it('allows HEAD without a nonce and the listed loopback Host values', () => {
    const hosts = [
      '127.0.0.1',
      `127.0.0.1:${PORT}`,
      'localhost',
      `localhost:${PORT}`,
      '[::1]',
      `[::1]:${PORT}`,
    ];
    for (const host of hosts) {
      const result = assertControlRequest(req('HEAD', { host }), { nonce: NONCE, port: PORT });
      expect(result, host).toEqual({ ok: true });
    }
  });

  it('allows listed loopback Origins when the nonce matches', () => {
    const origins = [
      `http://127.0.0.1:${PORT}`,
      `http://localhost:${PORT}`,
      `http://[::1]:${PORT}`,
    ];
    for (const origin of origins) {
      const result = assertControlRequest(
        req('POST', {
          host: `localhost:${PORT}`,
          origin,
          [CONTROL_NONCE_HEADER]: NONCE,
        }),
        { nonce: NONCE, port: PORT },
      );
      expect(result, origin).toEqual({ ok: true });
    }
  });

  it('rejects an unexpected Host', () => {
    const result = assertControlRequest(
      req('GET', { host: 'evil.example' }),
      { nonce: NONCE, port: PORT },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
  });

  it('rejects a nonce that does not match', () => {
    const result = assertControlRequest(
      req('POST', {
        host: `127.0.0.1:${PORT}`,
        [CONTROL_NONCE_HEADER]: 'wrong-nonce',
      }),
      { nonce: NONCE, port: PORT },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
  });
});
