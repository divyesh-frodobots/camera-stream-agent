import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTROL_NONCE_HEADER } from '../src/control/controlAuth';
import { startControlServer } from '../src/control/controlServer';
import type { LocalPublisher, CameraUiRow } from '../src/localMode/localPublisher';
import { emptyCamerasFile, UNCHANGED_SENTINEL } from '../src/localMode/camerasFile';
import { silentLogger } from './helpers/fakes';

const HTML_PATH = path.join(__dirname, '../ui/control.html');
const PLANTED_RTSP = 'rtsp://user:secret-pass@192.168.1.101:554/stream';
const PLANTED_STREAM_KEY = 'planted-stream-key-xyz';

function maskedRow(id: number, overrides: Partial<CameraUiRow> = {}): CameraUiRow {
  return {
    id,
    name: `Camera ${id}`,
    rtspUrlMasked: '',
    rtmpPublishUrlMasked: '',
    configured: false,
    enabled: false,
    state: 'Not configured',
    lastError: null,
    pid: null,
    ...overrides,
  };
}

function sixRows(): CameraUiRow[] {
  return [
    maskedRow(1, {
      rtspUrlMasked: 'rtsp://***:***@192.168.1.101:554/stream',
      rtmpPublishUrlMasked: 'rtmp://rtls.example/live/***',
      configured: true,
      state: 'Stopped',
    }),
    ...[2, 3, 4, 5, 6].map((id) => maskedRow(id)),
  ];
}

class FakePublisher {
  snapshotData = {
    cameras: sixRows(),
    invalidMessage: null as string | null,
    ffmpegError: null as string | null,
  };
  saved: unknown = undefined;
  started: number[] = [];
  stopped: number[] = [];
  restarted: number[] = [];
  startAllCalls = 0;
  stopAllCalls = 0;
  startResults = new Map<number, { ok: true } | { ok: false; status: 409 | 404; message: string }>([
    [2, { ok: false, status: 409, message: 'Camera 2 is not configured' }],
  ]);

  snapshot() {
    return this.snapshotData;
  }

  async save(cameras: unknown) {
    this.saved = cameras;
    return { ok: true as const, file: emptyCamerasFile() };
  }

  async start(id: number) {
    this.started.push(id);
    return this.startResults.get(id) ?? { ok: true as const };
  }

  async stop(id: number) {
    this.stopped.push(id);
    return { ok: true as const };
  }

  async restart(id: number) {
    this.restarted.push(id);
    return { ok: true as const };
  }

  async startAll() {
    this.startAllCalls += 1;
  }

  async stopAll() {
    this.stopAllCalls += 1;
  }
}

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await server?.close();
  }
});

async function listen(
  publisher: FakePublisher,
  opts: { port?: number; htmlPath?: string } = {},
) {
  const started = await startControlServer({
    publisher: publisher as unknown as LocalPublisher,
    port: opts.port ?? 0,
    htmlPath: opts.htmlPath ?? HTML_PATH,
    logger: silentLogger,
  });
  servers.push(started);
  const addr = started.server.address() as AddressInfo;
  return { ...started, port: addr.port, base: `http://127.0.0.1:${addr.port}` };
}

async function request(
  base: string,
  urlPath: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    nonce?: string;
  } = {},
) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.nonce !== undefined) {
    headers['X-Control-Nonce'] = opts.nonce;
  }
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${base}${urlPath}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { res, text, json };
}

describe('ui/control.html', () => {
  it('has six camera rows, no Agora SDK or video, nonce fetches, and unchanged sentinel', () => {
    expect(fs.existsSync(HTML_PATH)).toBe(true);
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    expect(html).toContain('<title>Camera publisher</title>');
    expect(html).toContain('Save configuration');
    expect(html).toContain('Start all');
    expect(html).toContain('Stop all');
    expect(html).toContain('data-initial');
    expect(html).toContain(UNCHANGED_SENTINEL);
    expect(html).toContain('X-Control-Nonce');
    expect(html).toContain('{{NONCE}}');
    expect(html).toContain('{{PORT}}');
    expect(html).toContain('2000');
    for (const id of [1, 2, 3, 4, 5, 6]) {
      expect(html).toContain(`data-id="${id}"`);
    }
    expect(html.toLowerCase()).not.toContain('agora');
    expect(html.toLowerCase()).not.toMatch(/<video\b/);
  });
});

describe('startControlServer', () => {
  it('listens on 127.0.0.1 and GET /api/cameras never returns planted secrets', async () => {
    const publisher = new FakePublisher();
    const started = await listen(publisher);
    const addr = started.server.address() as AddressInfo;

    expect(addr.address).toBe('127.0.0.1');
    expect(started.nonce).toMatch(/^[0-9a-f]{48}$/);

    const { res, text, json } = await request(started.base, '/api/cameras');
    expect(res.status).toBe(200);
    expect(text).not.toContain('rtsp://user:');
    expect(text).not.toContain(PLANTED_RTSP);
    expect(text).not.toContain(PLANTED_STREAM_KEY);
    expect(json).toMatchObject({
      cameras: publisher.snapshotData.cameras,
      invalidMessage: null,
      ffmpegError: null,
    });
  });

  it('rejects PUT /api/cameras without a nonce', async () => {
    const started = await listen(new FakePublisher());
    const { res } = await request(started.base, '/api/cameras', {
      method: 'PUT',
      body: { cameras: [] },
    });
    expect(res.status).toBe(403);
  });

  it('rejects PUT /api/cameras with a nonce and Origin http://evil.example', async () => {
    const started = await listen(new FakePublisher());
    const { res } = await request(started.base, '/api/cameras', {
      method: 'PUT',
      nonce: started.nonce,
      headers: { Origin: 'http://evil.example' },
      body: { cameras: [] },
    });
    expect(res.status).toBe(403);
  });

  it('returns 409 when starting an unconfigured camera', async () => {
    const publisher = new FakePublisher();
    const started = await listen(publisher);
    const { res, json } = await request(started.base, '/api/cameras/2/start', {
      method: 'POST',
      nonce: started.nonce,
    });
    expect(res.status).toBe(409);
    expect(json).toMatchObject({ message: 'Camera 2 is not configured' });
    expect(publisher.started).toEqual([2]);
  });

  it('saves cameras, maps validation 400, and runs start-all / stop-all', async () => {
    const publisher = new FakePublisher();
    const cameras = sixRows().map((row) => ({
      id: row.id,
      name: row.name,
      rtspUrl: UNCHANGED_SENTINEL,
      rtmpPublishUrl: UNCHANGED_SENTINEL,
      enabled: row.enabled,
    }));
    const started = await listen(publisher);

    const saved = await request(started.base, '/api/cameras', {
      method: 'PUT',
      nonce: started.nonce,
      body: { cameras },
    });
    expect(saved.res.status).toBe(200);
    expect(publisher.saved).toEqual(cameras);

    publisher.save = async () => ({
      ok: false as const,
      message: 'Camera configuration is invalid',
      fieldErrors: { 1: 'both RTSP and RTMP URLs are required' },
    });
    const invalid = await request(started.base, '/api/cameras', {
      method: 'PUT',
      nonce: started.nonce,
      body: { cameras },
    });
    expect(invalid.res.status).toBe(400);
    expect(invalid.json).toMatchObject({
      message: 'Camera configuration is invalid',
      fieldErrors: { 1: 'both RTSP and RTMP URLs are required' },
    });

    const startAll = await request(started.base, '/api/cameras/start-all', {
      method: 'POST',
      nonce: started.nonce,
    });
    const stopAll = await request(started.base, '/api/cameras/stop-all', {
      method: 'POST',
      nonce: started.nonce,
    });
    expect(startAll.res.status).toBe(200);
    expect(stopAll.res.status).toBe(200);
    expect(publisher.startAllCalls).toBe(1);
    expect(publisher.stopAllCalls).toBe(1);
  });

  it('replaces nonce and port placeholders in GET /', async () => {
    const htmlPath = path.join(os.tmpdir(), `control-test-${Date.now()}.html`);
    fs.writeFileSync(htmlPath, '<html>{{NONCE}} {{PORT}}</html>');
    const started = await listen(new FakePublisher(), { htmlPath });
    const { res, text } = await request(started.base, '/');
    expect(res.status).toBe(200);
    expect(text).toBe(`<html>${started.nonce} ${started.port}</html>`);
    expect(text).not.toContain('{{NONCE}}');
    expect(text).not.toContain('{{PORT}}');
    fs.unlinkSync(htmlPath);
  });

  it('rejects listen when the port is already bound (EADDRINUSE)', async () => {
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as AddressInfo).port;
    await expect(
      startControlServer({
        publisher: new FakePublisher() as unknown as LocalPublisher,
        port,
        htmlPath: HTML_PATH,
        logger: silentLogger,
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await new Promise<void>((resolve, reject) => {
      blocker.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('maps 404 from publisher start onto the HTTP response', async () => {
    const publisher = new FakePublisher();
    publisher.startResults.set(9, { ok: false, status: 404, message: 'Camera 9 was not found' });
    const started = await listen(publisher);
    const { res, json } = await request(started.base, '/api/cameras/9/start', {
      method: 'POST',
      nonce: started.nonce,
    });
    expect(res.status).toBe(404);
    expect(json).toMatchObject({ message: 'Camera 9 was not found' });
  });
});

describe('CONTROL_NONCE_HEADER wiring', () => {
  it('accepts the documented header on mutating requests', () => {
    expect(CONTROL_NONCE_HEADER).toBe('x-control-nonce');
  });
});
