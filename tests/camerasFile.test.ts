import { describe, it, expect } from 'vitest';
import {
  configuredCameras,
  emptyCamerasFile,
  parseCamerasFile,
  mergeCameraPut,
  UNCHANGED_SENTINEL,
} from '../src/localMode/camerasFile';

describe('parseCamerasFile', () => {
  it('accepts version 1 with ids 1-6', () => {
    const result = parseCamerasFile({
      version: 1,
      cameras: [{ id: 2, name: 'Pit', rtspUrl: 'rtsp://cam/live', rtmpPublishUrl: 'rtmp://x/live/k2', enabled: true }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.cameras).toHaveLength(6);
    expect(result.file.cameras[1]).toMatchObject({ id: 2, name: 'Pit', enabled: true });
    expect(result.file.cameras[0]?.name).toBe('Camera 1');
  });

  it('rejects unsupported version', () => {
    const result = parseCamerasFile({ version: 2, cameras: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/version/i);
  });

  it('rejects half-filled rows', () => {
    const result = parseCamerasFile({
      version: 1,
      cameras: [{ id: 1, name: 'A', rtspUrl: 'rtsp://cam/live', rtmpPublishUrl: '', enabled: false }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors?.[1]).toMatch(/both RTSP and RTMP/i);
  });

  it('rejects bad schemes and duplicate URLs', () => {
    const dup = parseCamerasFile({
      version: 1,
      cameras: [
        { id: 1, name: 'A', rtspUrl: 'rtsp://cam/a', rtmpPublishUrl: 'rtmp://x/live/k1', enabled: true },
        { id: 2, name: 'B', rtspUrl: 'rtsp://cam/a', rtmpPublishUrl: 'rtmp://x/live/k2', enabled: true },
      ],
    });
    expect(dup.ok).toBe(false);

    const http = parseCamerasFile({
      version: 1,
      cameras: [{ id: 1, name: 'A', rtspUrl: 'http://cam/a', rtmpPublishUrl: 'rtmp://x/live/k1', enabled: true }],
    });
    expect(http.ok).toBe(false);
  });

  it('rejects RTMP URLs without a stream key path segment', () => {
    const hostOnly = parseCamerasFile({
      version: 1,
      cameras: [{ id: 1, name: 'A', rtspUrl: 'rtsp://cam/a', rtmpPublishUrl: 'rtmp://host', enabled: true }],
    });
    expect(hostOnly.ok).toBe(false);
    if (hostOnly.ok) return;
    expect(hostOnly.fieldErrors?.[1]).toMatch(/stream key path segment/i);

    const trailingSlash = parseCamerasFile({
      version: 1,
      cameras: [{ id: 1, name: 'A', rtspUrl: 'rtsp://cam/a', rtmpPublishUrl: 'rtmp://host/live/', enabled: true }],
    });
    expect(trailingSlash.ok).toBe(false);
    if (trailingSlash.ok) return;
    expect(trailingSlash.fieldErrors?.[1]).toMatch(/stream key path segment/i);
  });

  it('rejects malformed field types instead of coercing', () => {
    const enabled = parseCamerasFile({
      version: 1,
      cameras: [
        { id: 1, name: 'A', rtspUrl: 'rtsp://cam/live', rtmpPublishUrl: 'rtmp://x/live/k1', enabled: 'true' },
      ],
    });
    expect(enabled.ok).toBe(false);
    if (enabled.ok) return;
    expect(enabled.fieldErrors?.[1]).toMatch(/enabled must be a boolean/i);

    const name = parseCamerasFile({
      version: 1,
      cameras: [{ id: 2, name: 123, rtspUrl: '', rtmpPublishUrl: '', enabled: false }],
    });
    expect(name.ok).toBe(false);
    if (name.ok) return;
    expect(name.fieldErrors?.[2]).toMatch(/name must be a string/i);
  });

  it('rejects more than six cameras or ids outside 1-6', () => {
    const extra = parseCamerasFile({
      version: 1,
      cameras: Array.from({ length: 7 }, (_, i) => ({
        id: i + 1,
        name: `C${i + 1}`,
        rtspUrl: `rtsp://cam/${i + 1}`,
        rtmpPublishUrl: `rtmp://x/live/k${i + 1}`,
        enabled: false,
      })),
    });
    expect(extra.ok).toBe(false);
  });
});

describe('configuredCameras', () => {
  it('returns only rows with both RTSP and RTMP URLs set', () => {
    const file = emptyCamerasFile();
    file.cameras[0] = {
      id: 1,
      name: 'Front',
      rtspUrl: 'rtsp://cam/front',
      rtmpPublishUrl: 'rtmp://x/live/k1',
      enabled: true,
    };
    file.cameras[2] = {
      id: 3,
      name: 'Pit',
      rtspUrl: 'rtsp://cam/pit',
      rtmpPublishUrl: 'rtmp://x/live/k3',
      enabled: false,
    };

    const configured = configuredCameras(file);

    expect(configured.map((c) => c.id)).toEqual([1, 3]);
    expect(configured.every((c) => c.rtspUrl && c.rtmpPublishUrl)).toBe(true);
  });

  it('returns an empty array when no rows are configured', () => {
    expect(configuredCameras(emptyCamerasFile())).toEqual([]);
  });

  it('excludes whitespace-only URLs and returns trimmed configured rows', () => {
    const file = emptyCamerasFile();
    file.cameras[0] = {
      id: 1,
      name: 'Front',
      rtspUrl: '  rtsp://cam/front  ',
      rtmpPublishUrl: '  rtmp://x/live/k1  ',
      enabled: true,
    };
    file.cameras[1] = {
      id: 2,
      name: 'Half',
      rtspUrl: 'rtsp://cam/half',
      rtmpPublishUrl: '   ',
      enabled: false,
    };

    const configured = configuredCameras(file);

    expect(configured).toHaveLength(1);
    expect(configured[0]).toMatchObject({
      id: 1,
      rtspUrl: 'rtsp://cam/front',
      rtmpPublishUrl: 'rtmp://x/live/k1',
    });
  });
});

describe('mergeCameraPut', () => {
  const emptyIncoming = () =>
    Array.from({ length: 6 }, (_, i) => ({
      id: i + 1,
      name: `Camera ${i + 1}`,
      rtspUrl: '',
      rtmpPublishUrl: '',
      enabled: false,
    }));

  it('rejects duplicate or extra incoming rows', () => {
    const stored = emptyCamerasFile();
    const rows = emptyIncoming();

    const duplicate = mergeCameraPut(stored, [...rows, { id: 1, name: 'Dup', rtspUrl: '', rtmpPublishUrl: '', enabled: false }]);
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) return;
    expect(duplicate.message).toMatch(/exactly 6 cameras/i);

    const repeatedId = mergeCameraPut(stored, [
      { id: 1, name: 'Camera 1', rtspUrl: '', rtmpPublishUrl: '', enabled: false },
      { id: 1, name: 'Dup', rtspUrl: '', rtmpPublishUrl: '', enabled: false },
      { id: 3, name: 'Camera 3', rtspUrl: '', rtmpPublishUrl: '', enabled: false },
      { id: 4, name: 'Camera 4', rtspUrl: '', rtmpPublishUrl: '', enabled: false },
      { id: 5, name: 'Camera 5', rtspUrl: '', rtmpPublishUrl: '', enabled: false },
      { id: 6, name: 'Camera 6', rtspUrl: '', rtmpPublishUrl: '', enabled: false },
    ]);
    expect(repeatedId.ok).toBe(false);
    if (repeatedId.ok) return;
    expect(repeatedId.message).toMatch(/exactly once/i);
  });

  it('keeps stored secrets when the sentinel is sent', () => {
    const stored = emptyCamerasFile();
    stored.cameras[0] = {
      id: 1,
      name: 'Front',
      rtspUrl: 'rtsp://user:pw@cam/live',
      rtmpPublishUrl: 'rtmp://x/live/secretKey',
      enabled: true,
    };
    const result = mergeCameraPut(stored, [
      { id: 1, name: 'Front', rtspUrl: UNCHANGED_SENTINEL, rtmpPublishUrl: UNCHANGED_SENTINEL, enabled: true },
      { id: 2, name: 'Camera 2', rtspUrl: '', rtmpPublishUrl: '', enabled: false },
      { id: 3, name: 'Camera 3', rtspUrl: '', rtmpPublishUrl: '', enabled: false },
      { id: 4, name: 'Camera 4', rtspUrl: '', rtmpPublishUrl: '', enabled: false },
      { id: 5, name: 'Camera 5', rtspUrl: '', rtmpPublishUrl: '', enabled: false },
      { id: 6, name: 'Camera 6', rtspUrl: '', rtmpPublishUrl: '', enabled: false },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.cameras[0]?.rtspUrl).toBe('rtsp://user:pw@cam/live');
    expect(result.file.cameras[0]?.rtmpPublishUrl).toBe('rtmp://x/live/secretKey');
  });
});
