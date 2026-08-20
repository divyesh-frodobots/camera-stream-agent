import type { AgentConfigCamera, AgentConfigResponse, CameraRuntimeStatus } from '../types/agentConfig';
import {
  diffConfig,
  toAgentCameras,
  type LocalVideoSettings,
} from '../services/configService';
import type { CameraProcessManager } from '../ffmpeg/CameraProcessManager';
import { maskRtmpUrl, maskUrl } from '../utils/mask';
import type { Logger } from '../utils/loggerTypes';
import {
  configuredCameras,
  emptyCamerasFile,
  mergeCameraPut,
  type CamerasParseResult,
  type StoredCamera,
  type StoredCamerasFile,
} from './camerasFile';
import type { CamerasStore } from './camerasStore';

export type UiCameraState =
  | 'Not configured'
  | 'Stopped'
  | 'Starting'
  | 'Live'
  | 'Reconnecting'
  | 'Error';

export interface CameraUiRow {
  id: number;
  name: string;
  rtspUrlMasked: string;
  rtmpPublishUrlMasked: string;
  configured: boolean;
  enabled: boolean;
  state: UiCameraState;
  lastError: string | null;
  pid: number | null;
}

type ActionResult =
  | { ok: true }
  | { ok: false; status: 409 | 404; message: string };

interface AppliedCameraState {
  camera: AgentConfigCamera | null;
  enabled: boolean;
}

export interface LocalPublisherActionFailure {
  cameraId: number;
  action: 'start' | 'stop' | 'restart' | 'forget';
  error: unknown;
}

export class LocalPublisherActionAggregateError extends AggregateError {
  constructor(readonly failures: LocalPublisherActionFailure[]) {
    const cameras = failures.map((failure) => failure.cameraId).join(', ');
    super(
      failures.map((failure) => failure.error),
      `Camera actions failed for camera ${cameras}`,
    );
    this.name = 'LocalPublisherActionAggregateError';
  }
}

function asConfig(cameras: AgentConfigCamera[]): AgentConfigResponse {
  return {
    agent: { id: 'local-agent', name: 'local', deviceId: 'local' },
    configVersion: 1,
    heartbeatIntervalSeconds: 15,
    cameras,
  };
}

function isConfigured(camera: StoredCamera): boolean {
  return camera.rtspUrl.trim().length > 0 && camera.rtmpPublishUrl.trim().length > 0;
}

function isRunningStatus(status: CameraRuntimeStatus | undefined): boolean {
  return status !== undefined && status !== 'STOPPED' && status !== 'DISABLED';
}

function uiState(configured: boolean, status: CameraRuntimeStatus | undefined): UiCameraState {
  if (!configured) return 'Not configured';
  switch (status) {
    case 'STREAMING':
      return 'Live';
    case 'STARTING':
      return 'Starting';
    case 'RECONNECTING':
      return 'Reconnecting';
    case 'ERROR':
      return 'Error';
    default:
      return 'Stopped';
  }
}

const MIN_STANDALONE_SECRET_LENGTH = 4;
const MASKED_ERROR = 'FFmpeg error (sensitive details redacted)';
const COMMON_SECRET_VALUES = new Set([
  'true',
  'false',
  'null',
  'none',
  'undefined',
  'unknown',
  'user',
  'admin',
  'root',
  'default',
  'password',
  'secret',
  'token',
]);

function replaceAll(value: string, secret: string, replacement: string): string {
  return secret.length > 0 ? value.split(secret).join(replacement) : value;
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encoded(value: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    return value;
  }
}

function percentLowerCase(value: string): string {
  return value.replace(/%[0-9A-F]{2}/g, (match) => match.toLowerCase());
}

function addSecret(
  secrets: Set<string>,
  skipped: Set<string>,
  value: string,
): void {
  if (!value) return;
  if (
    value.length < MIN_STANDALONE_SECRET_LENGTH ||
    COMMON_SECRET_VALUES.has(decoded(value).toLowerCase())
  ) {
    skipped.add(value);
    skipped.add(decoded(value));
    return;
  }
  secrets.add(value);
  secrets.add(percentLowerCase(value));
}

function collectUrlSecrets(
  rawUrl: string,
  includeFinalPathSegment: boolean,
): { fullUrls: Set<string>; secrets: Set<string>; skipped: Set<string> } {
  const fullUrls = new Set([rawUrl]);
  const secrets = new Set<string>();
  const skipped = new Set<string>();

  try {
    fullUrls.add(decodeURIComponent(rawUrl));
    const url = new URL(rawUrl);
    for (const credential of [url.username, url.password]) {
      const decodedCredential = decoded(credential);
      addSecret(secrets, skipped, credential);
      addSecret(secrets, skipped, decodedCredential);
      addSecret(secrets, skipped, encoded(decodedCredential));
    }

    if (includeFinalPathSegment) {
      const finalSegment = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
      const decodedSegment = decoded(finalSegment);
      addSecret(secrets, skipped, finalSegment);
      addSecret(secrets, skipped, decodedSegment);
      addSecret(secrets, skipped, encoded(decodedSegment));
    }

    const rawQuery = url.search.startsWith('?') ? url.search.slice(1) : url.search;
    for (const pair of rawQuery.split('&')) {
      if (!pair) continue;
      const separator = pair.indexOf('=');
      const rawValue = separator >= 0 ? pair.slice(separator + 1) : '';
      const decodedValue = decoded(rawValue.replace(/\+/g, ' '));
      addSecret(secrets, skipped, rawValue);
      addSecret(secrets, skipped, decodedValue);
      addSecret(secrets, skipped, encoded(decodedValue));
    }

    const rawFragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
    const decodedFragment = decoded(rawFragment);
    addSecret(secrets, skipped, rawFragment);
    addSecret(secrets, skipped, decodedFragment);
    addSecret(secrets, skipped, encoded(decodedFragment));
  } catch {
    skipped.add(rawUrl);
  }

  return { fullUrls, secrets, skipped };
}

function containsStandalone(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, 'i').test(haystack);
}

function sanitizeError(message: string | null, cameras: StoredCamera[]): string | null {
  if (message === null) return null;

  let sanitized = message;
  const allSecrets = new Set<string>();
  const skipped = new Set<string>();
  for (const camera of cameras) {
    if (camera.rtspUrl) {
      const rtsp = collectUrlSecrets(camera.rtspUrl, false);
      for (const fullUrl of rtsp.fullUrls) {
        sanitized = replaceAll(sanitized, fullUrl, maskUrl(camera.rtspUrl));
      }
      for (const secret of rtsp.secrets) allSecrets.add(secret);
      for (const value of rtsp.skipped) skipped.add(value);
    }

    if (camera.rtmpPublishUrl) {
      const rtmp = collectUrlSecrets(camera.rtmpPublishUrl, true);
      for (const fullUrl of rtmp.fullUrls) {
        sanitized = replaceAll(sanitized, fullUrl, maskRtmpUrl(camera.rtmpPublishUrl));
      }
      for (const secret of rtmp.secrets) allSecrets.add(secret);
      for (const value of rtmp.skipped) skipped.add(value);
    }
  }

  for (const secret of [...allSecrets].sort((a, b) => b.length - a.length)) {
    sanitized = replaceAll(sanitized, secret, '[REDACTED]');
  }
  if (
    [...allSecrets].some((secret) => sanitized.includes(secret)) ||
    [...skipped].some((value) => containsStandalone(sanitized, value))
  ) {
    return MASKED_ERROR;
  }
  return sanitized;
}

export class LocalPublisher {
  private file: StoredCamerasFile = emptyCamerasFile();
  private readonly applied = new Map<number, AppliedCameraState>();
  private invalidMessage: string | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly opts: {
      store: CamerasStore;
      processManager: CameraProcessManager;
      logger: Logger;
      video?: Partial<LocalVideoSettings>;
    },
  ) {}

  async load(): Promise<{ invalidMessage: string | null }> {
    return this.enqueue(async () => {
      const loaded = await this.opts.store.load();
      this.file = loaded.invalidMessage ? emptyCamerasFile() : loaded.file;
      this.invalidMessage = loaded.invalidMessage;
      this.initializeApplied();
      return { invalidMessage: this.invalidMessage };
    });
  }

  snapshot(): {
    cameras: CameraUiRow[];
    invalidMessage: string | null;
    ffmpegError: string | null;
  } {
    const cameras = this.file.cameras.map((camera) => {
      const configured = isConfigured(camera);
      const process = this.opts.processManager.getState(camera.id);
      return {
        id: camera.id,
        name: camera.name,
        rtspUrlMasked: maskUrl(camera.rtspUrl),
        rtmpPublishUrlMasked: maskRtmpUrl(camera.rtmpPublishUrl),
        configured,
        enabled: camera.enabled,
        state: uiState(configured, process?.status),
        lastError: sanitizeError(process?.lastError ?? null, this.file.cameras),
        pid: process?.pid ?? null,
      };
    });

    return {
      cameras,
      invalidMessage: this.invalidMessage,
      ffmpegError: cameras.find((camera) => camera.lastError !== null)?.lastError ?? null,
    };
  }

  async save(
    incoming: Array<Partial<StoredCamera> & { id: number }>,
  ): Promise<CamerasParseResult> {
    return this.enqueue(async () => {
      const merged = mergeCameraPut(this.file, incoming);
      if (!merged.ok) return merged;

      await this.opts.store.save(merged.file);
      this.file = merged.file;
      this.invalidMessage = null;
      await this.reconcileApplied();
      return merged;
    });
  }

  async start(id: number): Promise<ActionResult> {
    return this.enqueue(async () => {
      const camera = this.cameraById(id);
      if (!camera) return this.notFound(id);
      if (!isConfigured(camera)) {
        return { ok: false, status: 409, message: `Camera ${id} is not configured` };
      }

      await this.persistEnabled(id, true);
      const agentCamera = this.agentCamera(id)!;
      await this.opts.processManager.start(agentCamera);
      this.applied.set(id, { camera: agentCamera, enabled: true });
      return { ok: true };
    });
  }

  async stop(
    id: number,
  ): Promise<{ ok: true } | { ok: false; status: 404; message: string }> {
    return this.enqueue(async () => {
      const camera = this.cameraById(id);
      if (!camera) return this.notFound(id);

      await this.persistEnabled(id, false);
      await this.opts.processManager.stop(id);
      this.applied.set(id, { camera: this.agentCamera(id) ?? null, enabled: false });
      return { ok: true };
    });
  }

  async restart(id: number): Promise<ActionResult> {
    return this.enqueue(async () => {
      const camera = this.cameraById(id);
      if (!camera) return this.notFound(id);
      if (!isConfigured(camera)) {
        return { ok: false, status: 409, message: `Camera ${id} is not configured` };
      }

      await this.persistEnabled(id, true);
      const agentCamera = this.agentCamera(id)!;
      await this.opts.processManager.forceRestart(agentCamera);
      this.applied.set(id, { camera: agentCamera, enabled: true });
      return { ok: true };
    });
  }

  async startAll(): Promise<void> {
    return this.enqueue(async () => {
      const configured = configuredCameras(this.file);
      if (configured.length === 0) return;

      const configuredIds = new Set(configured.map((camera) => camera.id));
      const next = this.withEnabled((camera) => configuredIds.has(camera.id) || camera.enabled);
      await this.persist(next);

      const cameras = new Map(toAgentCameras(this.file, this.opts.video).map((camera) => [camera.id, camera]));
      this.markRowsWithoutActionsApplied(configuredIds);
      await this.runCameraActions(
        configured.map((camera) => {
          const agentCamera = cameras.get(camera.id)!;
          return {
            cameraId: camera.id,
            action: 'start' as const,
            run: () => this.opts.processManager.start(agentCamera),
            onSuccess: () => this.applied.set(camera.id, { camera: agentCamera, enabled: true }),
          };
        }),
      );
    });
  }

  async stopAll(): Promise<void> {
    return this.enqueue(async () => {
      const runningIds = this.file.cameras
        .map((camera) => camera.id)
        .filter((id) => isRunningStatus(this.opts.processManager.getState(id)?.status));
      await this.persist(this.withEnabled(() => false));
      const running = new Set(runningIds);
      this.markRowsWithoutActionsApplied(running);
      await this.runCameraActions(
        runningIds.map((id) => ({
          cameraId: id,
          action: 'stop' as const,
          run: () => this.opts.processManager.stop(id),
          onSuccess: () =>
            this.applied.set(id, { camera: this.agentCamera(id) ?? null, enabled: false }),
        })),
      );
    });
  }

  async startEnabledOnBoot(): Promise<void> {
    return this.enqueue(async () => {
      const enabled = new Set(
        configuredCameras(this.file)
          .filter((camera) => camera.enabled)
          .map((camera) => camera.id),
      );
      const actions = toAgentCameras(this.file, this.opts.video)
        .filter((camera) => enabled.has(camera.id))
        .map((camera) => ({
          cameraId: camera.id,
          action: 'start' as const,
          run: () => this.opts.processManager.start(camera),
          onSuccess: () => this.applied.set(camera.id, { camera, enabled: true }),
        }));
      await this.runCameraActions(actions);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.catch(() => {}).then(operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private cameraById(id: number): StoredCamera | undefined {
    return this.file.cameras.find((camera) => camera.id === id);
  }

  private agentCamera(id: number): AgentConfigCamera | undefined {
    return toAgentCameras(this.file, this.opts.video).find((camera) => camera.id === id);
  }

  private initializeApplied(): void {
    this.applied.clear();
    const cameras = new Map(
      toAgentCameras(this.file, this.opts.video).map((camera) => [camera.id, camera]),
    );
    for (const row of this.file.cameras) {
      this.applied.set(row.id, {
        camera: cameras.get(row.id) ?? null,
        enabled: false,
      });
    }
  }

  private async reconcileApplied(): Promise<void> {
    const desiredCameras = toAgentCameras(this.file, this.opts.video);
    const desiredById = new Map(desiredCameras.map((camera) => [camera.id, camera]));
    const desiredRows = new Map(this.file.cameras.map((camera) => [camera.id, camera]));
    const appliedCameras = [...this.applied.values()]
      .map((state) => state.camera)
      .filter((camera): camera is AgentConfigCamera => camera !== null);
    const diff = diffConfig(asConfig(appliedCameras), asConfig(desiredCameras));
    const added = new Set(diff.added.map((camera) => camera.id));
    const removed = new Set(diff.removed.map((camera) => camera.id));
    const changed = new Set(diff.changed.map((camera) => camera.id));
    const actions: Array<{
      cameraId: number;
      action: LocalPublisherActionFailure['action'];
      run: () => Promise<void>;
      onSuccess: () => void;
    }> = [];

    for (const row of this.file.cameras) {
      const id = row.id;
      const desiredCamera = desiredById.get(id) ?? null;
      const desiredEnabled = desiredCamera !== null && row.enabled;
      const applied = this.applied.get(id) ?? { camera: null, enabled: false };
      const applyDesired = () =>
        this.applied.set(id, { camera: desiredCamera, enabled: desiredEnabled });

      if (removed.has(id)) {
        actions.push({
          cameraId: id,
          action: 'forget',
          run: () => this.opts.processManager.forget(id),
          onSuccess: applyDesired,
        });
      } else if (added.has(id)) {
        if (desiredEnabled) {
          actions.push({
            cameraId: id,
            action: 'start',
            run: () => this.opts.processManager.start(desiredCamera!),
            onSuccess: applyDesired,
          });
        } else {
          applyDesired();
        }
      } else if (changed.has(id)) {
        if (
          desiredEnabled ||
          applied.enabled ||
          isRunningStatus(this.opts.processManager.getState(id)?.status)
        ) {
          actions.push({
            cameraId: id,
            action: 'restart',
            run: () => this.opts.processManager.forceRestart(desiredCamera!),
            onSuccess: applyDesired,
          });
        } else {
          applyDesired();
        }
      } else if (desiredEnabled && !applied.enabled) {
        actions.push({
          cameraId: id,
          action: 'start',
          run: () => this.opts.processManager.start(desiredCamera!),
          onSuccess: applyDesired,
        });
      } else if (!desiredEnabled && applied.enabled) {
        actions.push({
          cameraId: id,
          action: 'stop',
          run: () => this.opts.processManager.stop(id),
          onSuccess: applyDesired,
        });
      } else {
        applyDesired();
      }
    }

    await this.runCameraActions(actions);
  }

  private markRowsWithoutActionsApplied(actionIds: Set<number>): void {
    const cameras = new Map(
      toAgentCameras(this.file, this.opts.video).map((camera) => [camera.id, camera]),
    );
    for (const row of this.file.cameras) {
      if (!actionIds.has(row.id)) {
        this.applied.set(row.id, {
          camera: cameras.get(row.id) ?? null,
          enabled: Boolean(cameras.get(row.id) && row.enabled),
        });
      }
    }
  }

  private async runCameraActions(
    actions: Array<{
      cameraId: number;
      action: LocalPublisherActionFailure['action'];
      run: () => Promise<void>;
      onSuccess: () => void;
    }>,
  ): Promise<void> {
    const results = await Promise.allSettled(actions.map((action) => action.run()));
    const failures: LocalPublisherActionFailure[] = [];
    for (let index = 0; index < results.length; index++) {
      const result = results[index]!;
      const action = actions[index]!;
      if (result.status === 'fulfilled') {
        action.onSuccess();
      } else {
        failures.push({
          cameraId: action.cameraId,
          action: action.action,
          error: result.reason,
        });
      }
    }
    if (failures.length > 0) {
      throw new LocalPublisherActionAggregateError(failures);
    }
  }

  private withEnabled(enabled: (camera: StoredCamera) => boolean): StoredCamerasFile {
    return {
      version: 1,
      cameras: this.file.cameras.map((camera) => ({ ...camera, enabled: enabled(camera) })),
    };
  }

  private async persistEnabled(id: number, enabled: boolean): Promise<void> {
    await this.persist(this.withEnabled((camera) => (camera.id === id ? enabled : camera.enabled)));
  }

  private async persist(file: StoredCamerasFile): Promise<void> {
    await this.opts.store.save(file);
    this.file = file;
    this.invalidMessage = null;
  }

  private notFound(id: number): { ok: false; status: 404; message: string } {
    return { ok: false, status: 404, message: `Camera ${id} was not found` };
  }
}
