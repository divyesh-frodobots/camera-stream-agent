/** Mirrors the backend GET /api/camera-agent/config response. */
export interface AgentConfigCamera {
  id: number;
  name: string;
  rtspUrl: string;
  channel: string;
  uid: string;
  rtmpBaseUrl: string;
  streamKey: string;
  rtmpPublishUrl: string;
  streamKeyExpiresAt: string;
  video: {
    codec: string;
    preset: string;
    width: number;
    height: number;
    fps: number;
    bitrateKbps: number;
    maxrateKbps: number;
    bufsizeKbps: number;
    transcodeEnabled: boolean;
    rtspTransport: string;
  };
  audio: {
    enabled: boolean;
    codec: string;
    bitrateKbps: number;
  };
}

export interface AgentConfigResponse {
  agent: { id: string; name: string; deviceId: string };
  configVersion: number;
  heartbeatIntervalSeconds: number;
  cameras: AgentConfigCamera[];
}

export type CameraRuntimeStatus =
  | 'STARTING'
  | 'STREAMING'
  | 'RECONNECTING'
  | 'ERROR'
  | 'STOPPED'
  | 'DISABLED';

export interface HeartbeatCameraState {
  cameraId: number;
  status: CameraRuntimeStatus;
  pid?: number;
  uptime?: number;
  restartCount?: number;
}

export interface HeartbeatPayload {
  agentId: string;
  version: string;
  cameras: HeartbeatCameraState[];
}

export interface ViewerSessionResponse {
  appId: string;
  channel: string;
  uid: number;
  role: 'subscriber';
  token: string;
  expiresAt: string;
}