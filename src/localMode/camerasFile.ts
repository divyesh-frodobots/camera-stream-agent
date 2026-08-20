export const MAX_LOCAL_CAMERAS = 6;
export const UNCHANGED_SENTINEL = '__unchanged__';

export interface StoredCamera {
  id: number;
  name: string;
  rtspUrl: string;
  rtmpPublishUrl: string;
  enabled: boolean;
}

export interface StoredCamerasFile {
  version: 1;
  cameras: StoredCamera[];
}

export type CamerasParseResult =
  | { ok: true; file: StoredCamerasFile }
  | { ok: false; message: string; fieldErrors?: Record<number, string> };

const VALID_RTSP_PROTOCOLS = new Set(['rtsp:', 'rtsps:']);
const VALID_RTMP_PROTOCOLS = new Set(['rtmp:', 'rtmps:']);
const REQUIRED_IDS = new Set([1, 2, 3, 4, 5, 6]);

function defaultCamera(id: number): StoredCamera {
  return {
    id,
    name: `Camera ${id}`,
    rtspUrl: '',
    rtmpPublishUrl: '',
    enabled: false,
  };
}

export function emptyCamerasFile(): StoredCamerasFile {
  return {
    version: 1,
    cameras: Array.from({ length: MAX_LOCAL_CAMERAS }, (_, i) => defaultCamera(i + 1)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCameraRow(
  raw: unknown,
  fieldErrors: Record<number, string>,
): { camera: StoredCamera } | { invalidEntry: true } | { fieldErrorOnly: true } {
  if (!isRecord(raw)) {
    return { invalidEntry: true };
  }

  if (!('id' in raw)) {
    return { invalidEntry: true };
  }

  const id = raw.id;
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    return { invalidEntry: true };
  }

  if (id < 1 || id > MAX_LOCAL_CAMERAS) {
    fieldErrors[id] = `Camera id must be between 1 and ${MAX_LOCAL_CAMERAS}`;
    return { fieldErrorOnly: true };
  }

  const typeErrors: string[] = [];
  if ('name' in raw && typeof raw.name !== 'string') {
    typeErrors.push('name must be a string');
  }
  if ('rtspUrl' in raw && typeof raw.rtspUrl !== 'string') {
    typeErrors.push('rtspUrl must be a string');
  }
  if ('rtmpPublishUrl' in raw && typeof raw.rtmpPublishUrl !== 'string') {
    typeErrors.push('rtmpPublishUrl must be a string');
  }
  if ('enabled' in raw && typeof raw.enabled !== 'boolean') {
    typeErrors.push('enabled must be a boolean');
  }

  if (typeErrors.length > 0) {
    fieldErrors[id] = typeErrors.join('; ');
    return { fieldErrorOnly: true };
  }

  const name = typeof raw.name === 'string' ? raw.name.trim() : `Camera ${id}`;
  const rtspUrl = typeof raw.rtspUrl === 'string' ? raw.rtspUrl.trim() : '';
  const rtmpPublishUrl = typeof raw.rtmpPublishUrl === 'string' ? raw.rtmpPublishUrl.trim() : '';
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : false;

  return {
    camera: { id, name, rtspUrl, rtmpPublishUrl, enabled },
  };
}

function validateUrlScheme(url: string, allowed: Set<string>, label: string): string | null {
  try {
    const protocol = new URL(url).protocol;
    if (!allowed.has(protocol)) {
      return `${label} must use ${[...allowed].join(' or ')} scheme`;
    }
    return null;
  } catch {
    return `${label} is not a valid URL`;
  }
}

function validateRtmpPublishUrl(url: string): string | null {
  const schemeError = validateUrlScheme(url, VALID_RTMP_PROTOCOLS, 'RTMP URL');
  if (schemeError) {
    return schemeError;
  }

  try {
    const trimmedPath = new URL(url).pathname.replace(/\/+$/, '');
    const slash = trimmedPath.lastIndexOf('/');
    if (slash <= 0 || slash === trimmedPath.length - 1) {
      return 'RTMP URL must include a stream key path segment';
    }

    const streamKey = trimmedPath.slice(slash + 1);
    if (streamKey.length === 0) {
      return 'RTMP URL must include a stream key path segment';
    }

    return null;
  } catch {
    return 'RTMP URL is not a valid URL';
  }
}

function validateCameras(cameras: StoredCamera[]): CamerasParseResult {
  const fieldErrors: Record<number, string> = {};

  for (const camera of cameras) {
    const hasRtsp = camera.rtspUrl.length > 0;
    const hasRtmp = camera.rtmpPublishUrl.length > 0;

    if (hasRtsp !== hasRtmp) {
      fieldErrors[camera.id] = 'Provide both RTSP and RTMP URLs, or leave both empty';
      continue;
    }

    if (!hasRtsp) {
      continue;
    }

    const rtspError = validateUrlScheme(camera.rtspUrl, VALID_RTSP_PROTOCOLS, 'RTSP URL');
    if (rtspError) {
      fieldErrors[camera.id] = rtspError;
      continue;
    }

    const rtmpError = validateRtmpPublishUrl(camera.rtmpPublishUrl);
    if (rtmpError) {
      fieldErrors[camera.id] = rtmpError;
    }
  }

  const rtspSeen = new Map<string, number>();
  const rtmpSeen = new Map<string, number>();

  for (const camera of cameras) {
    if (!camera.rtspUrl) {
      continue;
    }

    const prevRtsp = rtspSeen.get(camera.rtspUrl);
    if (prevRtsp !== undefined) {
      fieldErrors[camera.id] = `Duplicate RTSP URL (also used by camera ${prevRtsp})`;
      fieldErrors[prevRtsp] = fieldErrors[prevRtsp] ?? `Duplicate RTSP URL (also used by camera ${camera.id})`;
    } else {
      rtspSeen.set(camera.rtspUrl, camera.id);
    }

    const prevRtmp = rtmpSeen.get(camera.rtmpPublishUrl);
    if (prevRtmp !== undefined) {
      fieldErrors[camera.id] = fieldErrors[camera.id] ?? `Duplicate RTMP URL (also used by camera ${prevRtmp})`;
      fieldErrors[prevRtmp] = fieldErrors[prevRtmp] ?? `Duplicate RTMP URL (also used by camera ${camera.id})`;
    } else {
      rtmpSeen.set(camera.rtmpPublishUrl, camera.id);
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, message: 'Camera configuration is invalid', fieldErrors };
  }

  return { ok: true, file: { version: 1, cameras } };
}

export function parseCamerasFile(raw: unknown): CamerasParseResult {
  if (!isRecord(raw)) {
    return { ok: false, message: 'Invalid cameras file' };
  }

  if (raw.version !== 1) {
    return { ok: false, message: 'Unsupported cameras file version' };
  }

  if (!Array.isArray(raw.cameras)) {
    return { ok: false, message: 'Invalid cameras file' };
  }

  if (raw.cameras.length > MAX_LOCAL_CAMERAS) {
    return { ok: false, message: `At most ${MAX_LOCAL_CAMERAS} cameras are allowed` };
  }

  const fieldErrors: Record<number, string> = {};
  const byId = new Map<number, StoredCamera>();

  for (const entry of raw.cameras) {
    const parsed = parseCameraRow(entry, fieldErrors);
    if ('invalidEntry' in parsed) {
      return { ok: false, message: 'Invalid camera entry' };
    }
    if ('fieldErrorOnly' in parsed) {
      continue;
    }

    const camera = parsed.camera;
    if (byId.has(camera.id)) {
      fieldErrors[camera.id] = `Duplicate camera id ${camera.id}`;
      continue;
    }

    byId.set(camera.id, camera);
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, message: 'Camera configuration is invalid', fieldErrors };
  }

  const cameras = Array.from({ length: MAX_LOCAL_CAMERAS }, (_, i) => {
    const id = i + 1;
    return byId.get(id) ?? defaultCamera(id);
  });

  return validateCameras(cameras);
}

function resolveField<T extends string | boolean>(
  incoming: T | typeof UNCHANGED_SENTINEL | undefined,
  stored: T,
): T {
  if (incoming === UNCHANGED_SENTINEL || incoming === undefined) {
    return stored;
  }
  return incoming;
}

export function mergeCameraPut(
  stored: StoredCamerasFile,
  incoming: Array<Partial<StoredCamera> & { id: number }>,
): CamerasParseResult {
  if (incoming.length !== MAX_LOCAL_CAMERAS) {
    return { ok: false, message: 'Request must include exactly 6 cameras' };
  }

  const incomingIds = new Set(incoming.map((row) => row.id));
  if (incomingIds.size !== MAX_LOCAL_CAMERAS || ![...REQUIRED_IDS].every((id) => incomingIds.has(id))) {
    return { ok: false, message: 'Request must include cameras with ids 1 through 6 exactly once' };
  }

  const storedById = new Map(stored.cameras.map((camera) => [camera.id, camera]));
  const mergedCameras: StoredCamera[] = [];

  for (const id of [...REQUIRED_IDS].sort((a, b) => a - b)) {
    const storedCamera = storedById.get(id) ?? defaultCamera(id);
    const patch = incoming.find((row) => row.id === id);
    if (!patch) {
      return { ok: false, message: 'Request must include cameras with ids 1 through 6' };
    }

    mergedCameras.push({
      id,
      name: resolveField(
        typeof patch.name === 'string' ? patch.name.trim() : patch.name,
        storedCamera.name,
      ),
      rtspUrl: resolveField(
        typeof patch.rtspUrl === 'string' ? patch.rtspUrl.trim() : patch.rtspUrl,
        storedCamera.rtspUrl,
      ),
      rtmpPublishUrl: resolveField(
        typeof patch.rtmpPublishUrl === 'string' ? patch.rtmpPublishUrl.trim() : patch.rtmpPublishUrl,
        storedCamera.rtmpPublishUrl,
      ),
      enabled: resolveField(patch.enabled, storedCamera.enabled),
    });
  }

  return parseCamerasFile({ version: 1, cameras: mergedCameras });
}

export function configuredCameras(file: StoredCamerasFile): StoredCamera[] {
  return file.cameras
    .map((camera) => ({
      ...camera,
      rtspUrl: camera.rtspUrl.trim(),
      rtmpPublishUrl: camera.rtmpPublishUrl.trim(),
    }))
    .filter((camera) => camera.rtspUrl.length > 0 && camera.rtmpPublishUrl.length > 0);
}
