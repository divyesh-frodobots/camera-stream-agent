import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CamerasStore, DEFAULT_CAMERAS_PATH } from '../src/localMode/camerasStore';
import { emptyCamerasFile } from '../src/localMode/camerasFile';

async function listTempArtifacts(dataDir: string): Promise<string[]> {
  const entries = await fs.readdir(dataDir);
  return entries.filter((name) => name.startsWith('.cameras.json.') && name.endsWith('.tmp'));
}

describe('DEFAULT_CAMERAS_PATH', () => {
  it('is relative to agent root', () => {
    expect(DEFAULT_CAMERAS_PATH).toBe('data/cameras.json');
  });
});

describe('CamerasStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cameras-store-'));
    filePath = path.join(dir, 'data', 'cameras.json');
  });

  it('returns empty six when file is missing', async () => {
    const store = new CamerasStore({ filePath });
    const result = await store.load();
    expect(result.invalidMessage).toBeNull();
    expect(result.file).toEqual(emptyCamerasFile());
  });

  it('round-trips save and load', async () => {
    const store = new CamerasStore({ filePath });
    const file = emptyCamerasFile();
    file.cameras[0] = {
      id: 1,
      name: 'Front',
      rtspUrl: 'rtsp://cam/live',
      rtmpPublishUrl: 'rtmp://x/live/k1',
      enabled: true,
    };
    await store.save(file);
    const loaded = await store.load();
    expect(loaded.invalidMessage).toBeNull();
    expect(loaded.file).toEqual(file);
  });

  it('returns invalidMessage for invalid JSON without throwing', async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{ not json', 'utf8');
    const store = new CamerasStore({ filePath });
    const result = await store.load();
    expect(result.file).toEqual(emptyCamerasFile());
    expect(result.invalidMessage).toBeTruthy();
  });

  it('returns invalidMessage for unsupported version without throwing', async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ version: 2, cameras: [] }), 'utf8');
    const store = new CamerasStore({ filePath });
    const result = await store.load();
    expect(result.file).toEqual(emptyCamerasFile());
    expect(result.invalidMessage).toMatch(/version/i);
  });

  it('leaves no temp artifacts after successful save', async () => {
    const store = new CamerasStore({ filePath });
    await store.save(emptyCamerasFile());
    const dataDir = path.dirname(filePath);
    expect(await listTempArtifacts(dataDir)).toHaveLength(0);
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it('creates parent data directory on save', async () => {
    const store = new CamerasStore({ filePath });
    await store.save(emptyCamerasFile());
    await expect(fs.access(path.dirname(filePath))).resolves.toBeUndefined();
  });

  it('chmod 0o600 after save (best-effort, injectable)', async () => {
    const chmodCalls: Array<{ path: string; mode: number }> = [];
    const store = new CamerasStore({
      filePath,
      chmod: async (p, mode) => {
        chmodCalls.push({ path: p, mode });
      },
    });
    await store.save(emptyCamerasFile());
    expect(chmodCalls).toEqual([{ path: filePath, mode: 0o600 }]);
  });

  it('swallows chmod failures without rejecting save', async () => {
    const store = new CamerasStore({
      filePath,
      chmod: async () => {
        throw new Error('chmod not supported');
      },
    });
    await expect(store.save(emptyCamerasFile())).resolves.toBeUndefined();
    const loaded = await store.load();
    expect(loaded.invalidMessage).toBeNull();
    expect(loaded.file).toEqual(emptyCamerasFile());
  });

  it('cleans up temp file when rename fails', async () => {
    const store = new CamerasStore({ filePath });
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'));

    await expect(store.save(emptyCamerasFile())).rejects.toThrow('rename failed');

    const dataDir = path.dirname(filePath);
    expect(await listTempArtifacts(dataDir)).toHaveLength(0);
    await expect(fs.access(filePath)).rejects.toThrow();

    renameSpy.mockRestore();
  });

  it('concurrent saves both resolve with one valid payload and no temp artifacts', async () => {
    const store = new CamerasStore({ filePath });

    const fileA = emptyCamerasFile();
    fileA.cameras[0] = {
      id: 1,
      name: 'Alpha',
      rtspUrl: 'rtsp://a/live',
      rtmpPublishUrl: 'rtmp://x/live/a',
      enabled: true,
    };

    const fileB = emptyCamerasFile();
    fileB.cameras[0] = {
      id: 1,
      name: 'Beta',
      rtspUrl: 'rtsp://b/live',
      rtmpPublishUrl: 'rtmp://x/live/b',
      enabled: true,
    };

    await Promise.all([store.save(fileA), store.save(fileB)]);

    const loaded = await store.load();
    expect(loaded.invalidMessage).toBeNull();
    expect(loaded.file.cameras).toHaveLength(6);
    expect(['Alpha', 'Beta']).toContain(loaded.file.cameras[0]?.name);

    const matched = [fileA, fileB].find((candidate) => JSON.stringify(candidate) === JSON.stringify(loaded.file));
    expect(matched).toBeDefined();

    const dataDir = path.dirname(filePath);
    expect(await listTempArtifacts(dataDir)).toHaveLength(0);
  });
});
