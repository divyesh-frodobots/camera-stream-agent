import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { emptyCamerasFile, parseCamerasFile, type StoredCamerasFile } from './camerasFile';

export const DEFAULT_CAMERAS_PATH = 'data/cameras.json';

type ChmodFn = (filePath: string, mode: number) => Promise<void>;

const defaultChmod: ChmodFn = (filePath, mode) => fs.chmod(filePath, mode);

function isEnoent(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

function tempPathFor(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  return path.join(dir, `.${base}.${process.pid}.${randomUUID()}.tmp`);
}

async function unlinkBestEffort(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore missing or unreadable temp files during cleanup.
  }
}

export class CamerasStore {
  private readonly filePath: string;
  private readonly chmod: ChmodFn;

  constructor(opts: { filePath: string; chmod?: ChmodFn }) {
    this.filePath = opts.filePath;
    this.chmod = opts.chmod ?? defaultChmod;
  }

  async load(): Promise<{ file: StoredCamerasFile; invalidMessage: string | null }> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (isEnoent(err)) {
        return { file: emptyCamerasFile(), invalidMessage: null };
      }
      return {
        file: emptyCamerasFile(),
        invalidMessage: err instanceof Error ? err.message : 'Failed to read cameras file',
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        file: emptyCamerasFile(),
        invalidMessage: err instanceof Error ? err.message : 'Invalid JSON in cameras file',
      };
    }

    const result = parseCamerasFile(parsed);
    if (!result.ok) {
      return { file: emptyCamerasFile(), invalidMessage: result.message };
    }

    return { file: result.file, invalidMessage: null };
  }

  async save(file: StoredCamerasFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    const tmpPath = tempPathFor(this.filePath);
    try {
      await fs.writeFile(tmpPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
      await fs.rename(tmpPath, this.filePath);

      try {
        await this.chmod(this.filePath, 0o600);
      } catch {
        // chmod is best-effort (e.g. Windows may not support Unix modes).
      }
    } finally {
      await unlinkBestEffort(tmpPath);
    }
  }
}
