import { describe, it, expect, beforeEach } from 'vitest';
import { buildFfmpegArgs } from '../src/ffmpeg/ffmpegArgs';
import type { AgentConfigCamera } from '../src/types/agentConfig';

function makeCamera(overrides: Partial<AgentConfigCamera> = {}): AgentConfigCamera {
  return {
    id: 1,
    name: 'Front Camera',
    rtspUrl: 'rtsp://user:pw@192.168.1.64:554/stream1',
    channel: 'offroad_cam_1',
    uid: '1001',
    rtmpBaseUrl: 'rtmp://rtls-ingress-prod-ap.agoramdn.com/live',
    streamKey: 'sk-secret-1234',
    rtmpPublishUrl: 'rtmp://rtls-ingress-prod-ap.agoramdn.com/live/sk-secret-1234',
    streamKeyExpiresAt: new Date().toISOString(),
    video: {
      codec: 'libx264',
      preset: 'veryfast',
      width: 1920,
      height: 1080,
      fps: 25,
      bitrateKbps: 3000,
      maxrateKbps: 3000,
      bufsizeKbps: 6000,
      transcodeEnabled: true,
      rtspTransport: 'tcp',
    },
    audio: { enabled: true, codec: 'aac', bitrateKbps: 160 },
    ...overrides,
  };
}

describe('buildFfmpegArgs', () => {
  it('returns an argument array (never a shell string)', () => {
    const args = buildFfmpegArgs(makeCamera());
    expect(Array.isArray(args)).toBe(true);
    expect(args.join(' ')).not.toContain(';') ;
    expect(args.join(' ')).not.toContain('&&');
  });

  it('passes the raw RTSP URL as a single argument without shell interpretation', () => {
    const camera = makeCamera({ rtspUrl: 'rtsp://user:pw$HOME;rm -rf /@cam:554/x?foo=bar&baz=1' });
    const args = buildFfmpegArgs(camera);
    const idx = args.indexOf(camera.rtspUrl);
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx]).toBe(camera.rtspUrl);
  });

  it('uses TCP RTSP transport by default', () => {
    const args = buildFfmpegArgs(makeCamera());
    expect(args).toContain('-rtsp_transport');
    const idx = args.indexOf('-rtsp_transport');
    expect(args[idx + 1]).toBe('tcp');
  });

  it('honors UDP transport config', () => {
    const camera = makeCamera();
    camera.video = { ...camera.video, rtspTransport: 'udp' };
    const args = buildFfmpegArgs(camera);
    const idx = args.indexOf('-rtsp_transport');
    expect(args[idx + 1]).toBe('udp');
  });

  it('builds transcoding parameters when transcodeEnabled', () => {
    const args = buildFfmpegArgs(makeCamera());
    expect(args).toContain('-c:v');
    expect(args[args.indexOf('-c:v') + 1]).toBe('libx264');
    expect(args).toContain('-b:v');
    expect(args[args.indexOf('-b:v') + 1]).toBe('3000k');
    expect(args).toContain('-s');
    expect(args[args.indexOf('-s') + 1]).toBe('1920x1080');
    expect(args).toContain('-g');
    expect(args[args.indexOf('-g') + 1]).toBe('50'); // 2s keyframe interval at 25fps
    expect(args).toContain('baseline');
    expect(args).toContain('yuv420p');
  });

  it('uses stream copy when transcode is disabled (camera stream already compatible)', () => {
    const camera = makeCamera();
    camera.video = { ...camera.video, transcodeEnabled: false };
    const args = buildFfmpegArgs(camera);
    const cIdx = args.indexOf('-c:v');
    expect(args[cIdx + 1]).toBe('copy');
    expect(args).not.toContain('-b:v');
    expect(args).not.toContain('-s');
  });

  it('drops audio with -an when audio is disabled', () => {
    const camera = makeCamera();
    camera.audio = { ...camera.audio, enabled: false };
    const args = buildFfmpegArgs(camera);
    expect(args).toContain('-an');
    expect(args).not.toContain('-c:a');
  });

  it('publishes to the full RTMP URL with FLV muxer', () => {
    const camera = makeCamera();
    const args = buildFfmpegArgs(camera);
    expect(args[args.indexOf('-f') + 1]).toBe('flv');
    expect(args[args.length - 1]).toBe(camera.rtmpPublishUrl);
  });

  it('writes machine-readable progress to stdout for monitoring', () => {
    const args = buildFfmpegArgs(makeCamera());
    expect(args).toContain('-progress');
    expect(args[args.indexOf('-progress') + 1]).toBe('pipe:1');
  });

  it('appends extra arguments before the output URL', () => {
    const args = buildFfmpegArgs(makeCamera(), { extraArgs: ['-flvflags', 'no_duration_filesize'] });
    expect(args).toContain('-flvflags');
  });
});