import type { AgentConfigCamera } from '../types/agentConfig';
import { env } from '../config/env';

export interface BuildArgsOptions {
  /** Extra arguments appended after the standard set (e.g. for tests). */
  extraArgs?: string[];
}

/**
 * Builds the FFmpeg argument array for publishing one camera's RTSP stream
 * to the Agora RTMP gateway. Returns an array - NEVER a shell string - so
 * RTSP URLs, credentials and stream keys cannot cause command injection.
 *
 * Pipeline: RTSP -> H.264/AAC -> FLV -> RTMP (Agora Media Gateway)
 *
 * Transcoding is applied only when camera.transcodeEnabled is true. When the
 * camera's H.264/AAC stream is already Agora-compatible, -c copy avoids the
 * CPU cost of re-encoding.
 */
export function buildFfmpegArgs(camera: AgentConfigCamera, options: BuildArgsOptions = {}): string[] {
  const args: string[] = [
    '-hide_banner',
    '-loglevel',
    'info',
    '-nostdin',
    // machine-readable progress on stdout for health monitoring
    '-progress',
    'pipe:1',
  ];

  const isRtsp = camera.rtspUrl.toLowerCase().startsWith('rtsp://');
  const transport = camera.video.rtspTransport === 'udp' ? 'udp' : 'tcp';

  if (isRtsp) {
    // TCP transport by default: more reliable than UDP for RTSP cameras.
    args.push('-rtsp_transport', transport);
    if (env.RTSP_TIMEOUT_MICROS > 0) {
      args.push('-timeout', String(env.RTSP_TIMEOUT_MICROS));
    }
  }

  // Live ingest: do not let slow RTSP timestamps accumulate minutes of delay
  // in Agora. Wall-clock PTS + low-delay flags keep the published stream near
  // realtime even when the camera delivers less than 1x.
  args.push(
    '-fflags',
    '+nobuffer+genpts+discardcorrupt',
    '-flags',
    'low_delay',
    '-use_wallclock_as_timestamps',
    '1',
    '-probesize',
    env.FFMPEG_PROBESIZE,
    '-analyzeduration',
    env.FFMPEG_ANALYZEDURATION,
    '-i',
    camera.rtspUrl,
  );

  if (camera.video.transcodeEnabled) {
    args.push(
      '-c:v',
      camera.video.codec || 'libx264',
      '-preset',
      camera.video.preset || 'veryfast',
      '-tune',
      'zerolatency',
      '-b:v',
      `${camera.video.bitrateKbps}k`,
      '-maxrate',
      `${camera.video.maxrateKbps}k`,
      '-bufsize',
      `${camera.video.bufsizeKbps}k`,
      '-r',
      String(camera.video.fps),
      '-s',
      `${camera.video.width}x${camera.video.height}`,
      // 2s keyframe interval - Agora's recommended config for web clients
      '-g',
      String(camera.video.fps * 2),
      '-keyint_min',
      String(camera.video.fps * 2),
      '-profile:v',
      'baseline',
      '-pix_fmt',
      'yuv420p',
    );
  } else {
    // Camera stream is assumed H.264/AAC compatible with Agora: remux only.
    args.push('-c:v', 'copy');
  }

  if (camera.audio.enabled) {
    if (camera.video.transcodeEnabled) {
      args.push(
        '-c:a',
        camera.audio.codec || 'aac',
        '-b:a',
        `${camera.audio.bitrateKbps}k`,
        '-ar',
        '44100',
        '-ac',
        '2',
        // IP Webcam ulaw + wall-clock PTS can go slightly backwards; stretch
        // AAC so FLV/RTMP does not get non-monotonic DTS.
        '-af',
        'aresample=async=1:first_pts=0',
      );
    } else {
      args.push('-c:a', 'copy');
    }
  } else {
    args.push('-an');
  }

  args.push('-f', 'flv', '-rtmp_live', 'live');
  if (options.extraArgs) args.push(...options.extraArgs);
  args.push(camera.rtmpPublishUrl);

  return args;
}