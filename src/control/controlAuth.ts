import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const CONTROL_NONCE_HEADER = 'x-control-nonce';

function allowedHosts(port: number): Set<string> {
  return new Set([
    '127.0.0.1',
    `127.0.0.1:${port}`,
    'localhost',
    `localhost:${port}`,
    '[::1]',
    `[::1]:${port}`,
  ]);
}

function allowedOrigins(port: number): Set<string> {
  return new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function noncesEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function assertControlRequest(
  req: IncomingMessage,
  opts: { nonce: string; port: number },
): { ok: true } | { ok: false; status: 403; message: string } {
  const host = headerValue(req.headers.host)?.toLowerCase();
  if (!host || !allowedHosts(opts.port).has(host)) {
    return { ok: false, status: 403, message: 'Forbidden host' };
  }

  const origin = headerValue(req.headers.origin);
  if (origin !== undefined && origin !== '') {
    if (!allowedOrigins(opts.port).has(origin.toLowerCase())) {
      return { ok: false, status: 403, message: 'Forbidden origin' };
    }
  }

  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const provided = headerValue(req.headers[CONTROL_NONCE_HEADER]);
    if (!provided || !noncesEqual(provided, opts.nonce)) {
      return { ok: false, status: 403, message: 'Forbidden nonce' };
    }
  }

  return { ok: true };
}
