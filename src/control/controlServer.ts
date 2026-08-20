import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { assertControlRequest } from './controlAuth';
import type { LocalPublisher } from '../localMode/localPublisher';
import type { Logger } from '../utils/loggerTypes';

export async function startControlServer(opts: {
  publisher: LocalPublisher;
  port: number;
  htmlPath: string;
  logger: Logger;
}): Promise<{ server: http.Server; nonce: string; close: () => Promise<void> }> {
  const nonce = crypto.randomBytes(24).toString('hex');
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, { ...opts, nonce, server });
  });

  await listenLoopback(server, opts.port);

  const address = server.address() as AddressInfo;
  opts.logger.info({ url: `http://127.0.0.1:${address.port}` }, 'control server listening (loopback only)');

  return {
    server,
    nonce,
    close: () =>
      new Promise((resolve, reject) => {
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function listenLoopback(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function boundPort(server: http.Server, fallback: number): number {
  const address = server.address();
  return address && typeof address === 'object' ? address.port : fallback;
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: {
    publisher: LocalPublisher;
    htmlPath: string;
    logger: Logger;
    nonce: string;
    server: http.Server;
    port: number;
  },
): Promise<void> {
  const port = boundPort(ctx.server, ctx.port);
  const auth = assertControlRequest(req, { nonce: ctx.nonce, port });
  if (!auth.ok) {
    sendJson(res, auth.status, { message: auth.message });
    return;
  }

  const method = (req.method ?? 'GET').toUpperCase();
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

  try {
    if ((method === 'GET' || method === 'HEAD') && pathname === '/') {
      const html = await fs.readFile(ctx.htmlPath, 'utf8');
      const body = html.replaceAll('{{NONCE}}', ctx.nonce).replaceAll('{{PORT}}', String(port));
      send(res, 200, method === 'HEAD' ? '' : body, 'text/html; charset=utf-8');
      return;
    }

    if (method === 'GET' && pathname === '/api/cameras') {
      sendJson(res, 200, ctx.publisher.snapshot());
      return;
    }

    if (method === 'PUT' && pathname === '/api/cameras') {
      const body = await readJson(req);
      const cameras = isCamerasBody(body) ? body.cameras : null;
      if (!cameras) {
        sendJson(res, 400, { message: 'Request must include a cameras array' });
        return;
      }
      const result = await ctx.publisher.save(cameras);
      if (!result.ok) {
        sendJson(res, 400, { message: result.message, fieldErrors: result.fieldErrors });
        return;
      }
      sendJson(res, 200, ctx.publisher.snapshot());
      return;
    }

    if (method === 'POST' && pathname === '/api/cameras/start-all') {
      await ctx.publisher.startAll();
      sendJson(res, 200, ctx.publisher.snapshot());
      return;
    }

    if (method === 'POST' && pathname === '/api/cameras/stop-all') {
      await ctx.publisher.stopAll();
      sendJson(res, 200, ctx.publisher.snapshot());
      return;
    }

    const cameraAction = pathname.match(/^\/api\/cameras\/(\d+)\/(start|stop|restart)$/);
    if (method === 'POST' && cameraAction) {
      const id = Number(cameraAction[1]);
      const action = cameraAction[2] as 'start' | 'stop' | 'restart';
      const result = await ctx.publisher[action](id);
      if (!result.ok) {
        sendJson(res, result.status, { message: result.message });
        return;
      }
      sendJson(res, 200, ctx.publisher.snapshot());
      return;
    }

    sendJson(res, 404, { message: 'Not found' });
  } catch (err) {
    const status = jsonErrorStatus(err);
    if (status !== 500) {
      sendJson(res, status, { message: err instanceof Error ? err.message : 'Bad request' });
      return;
    }
    ctx.logger.error({ err }, 'control request failed');
    sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
  }
}

function isCamerasBody(body: unknown): body is { cameras: Array<Record<string, unknown> & { id: number }> } {
  return (
    typeof body === 'object' &&
    body !== null &&
    Array.isArray((body as { cameras?: unknown }).cameras)
  );
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('Invalid JSON') as Error & { status: number };
    error.status = 400;
    throw error;
  }
}

function jsonErrorStatus(err: unknown): number {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return 500;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

function send(res: http.ServerResponse, status: number, body: string, contentType: string): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
