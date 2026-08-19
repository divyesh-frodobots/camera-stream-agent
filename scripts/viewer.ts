/**
 * Localhost Agora viewer for local stream mode.
 *
 *   npm run viewer
 *   open http://127.0.0.1:3456
 *
 * Uses AGORA_* fields written by `npm run pull-local-config`. Does not call
 * the camera backend.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { env } from '../src/config/env';
import { readViewerSessionFromEnv } from '../src/localMode/viewerSession';
import { resolveSdkBundle } from '../src/localMode/viewerSdk';
import { logger } from '../src/utils/logger';

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'viewer', 'index.html');
const HOST = '127.0.0.1';

function send(res: http.ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';
  const pathOnly = url.split('?')[0] ?? '/';

  if (req.method === 'GET' && (pathOnly === '/' || pathOnly === '/index.html')) {
    try {
      const html = fs.readFileSync(HTML_PATH, 'utf8');
      send(res, 200, html, 'text/html; charset=utf-8');
    } catch {
      send(res, 500, 'viewer/index.html missing', 'text/plain; charset=utf-8');
    }
    return;
  }

  if (req.method === 'GET' && pathOnly === '/agora-rtc-sdk.js') {
    const bundle = resolveSdkBundle(ROOT);
    if (!bundle) {
      send(res, 404, '// agora-rtc-sdk-ng not installed. Run npm install.', 'application/javascript');
      return;
    }
    send(res, 200, fs.readFileSync(bundle, 'utf8'), 'application/javascript');
    return;
  }

  if (req.method === 'GET' && pathOnly === '/session') {
    const result = readViewerSessionFromEnv(env);
    if (!result.ok) {
      send(res, 409, JSON.stringify({ error: 'SESSION_UNAVAILABLE', message: result.message }), 'application/json');
      return;
    }
    send(res, 200, JSON.stringify(result.session), 'application/json');
    return;
  }

  send(res, 404, 'Not found', 'text/plain; charset=utf-8');
});

server.listen(env.AGORA_VIEWER_PORT, HOST, () => {
  logger.info({ url: `http://${HOST}:${env.AGORA_VIEWER_PORT}` }, 'agora viewer listening (loopback only)');
});
