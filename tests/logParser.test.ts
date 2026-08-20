import { describe, it, expect } from 'vitest';
import { parseFfmpegLine, ProgressTracker } from '../src/ffmpeg/ffmpegLogParser';

describe('parseFfmpegLine', () => {
  it('parses machine-readable progress key/value lines', () => {
    const line = parseFfmpegLine('frame=123');
    expect(line.kind).toBe('progress');
    expect(line.progressKey).toBe('frame');
    expect(line.progressValue).toBe('123');

    const cont = parseFfmpegLine('progress=continue');
    expect(cont.progressKey).toBe('progress');
    expect(cont.progressValue).toBe('continue');
  });

  it('classifies RTSP connection errors', () => {
    const line = parseFfmpegLine('rtsp://...: Connection timed out');
    expect(line.kind).toBe('error');
    expect(line.errorCategory).toBe('rtsp_connect');
  });

  it('classifies RTMP connection errors', () => {
    const line = parseFfmpegLine('rtmp://...: Connection refused');
    expect(line.errorCategory).toBe('rtmp_connect');
  });

  it('classifies auth failures', () => {
    expect(parseFfmpegLine('Server returned 401 Unauthorized').errorCategory).toBe('auth');
    expect(parseFfmpegLine('Authentication failed').errorCategory).toBe('auth');
  });

  it('does not treat DTS timestamp numbers as HTTP 401/404', () => {
    const dts = parseFfmpegLine(
      '[aost#0:1/aac @ 0x717060900] Non-monotonic DTS; previous: 184051, current: 184039; changing to 184051. This may result in incorrect timestamps in the output file.',
    );
    expect(dts.kind).toBe('warning');
    expect(dts.errorCategory).toBeUndefined();

    const dts404 = parseFfmpegLine(
      '[aost#0:1/aac @ 0x717060900] Non-monotonic DTS; previous: 240492, current: 240489; changing to 240492. This may result in incorrect timestamps in the output file.',
    );
    expect(dts404.kind).toBe('warning');
    expect(dts404.errorCategory).toBeUndefined();
  });

  it('classifies not-found errors', () => {
    expect(parseFfmpegLine('Server returned 404 Not Found').errorCategory).toBe('not_found');
    expect(parseFfmpegLine('rtsp://...: No such file or directory').errorCategory).toBe('not_found');
  });

  it('leaves informational lines as info', () => {
    const line = parseFfmpegLine('  Metadata:  ');
    expect(line.kind).toBe('info');
  });
});

describe('ProgressTracker', () => {
  it('accumulates progress snapshots and marks last update on continue', () => {
    const t = new ProgressTracker();
    t.update('frame', '150');
    t.update('fps', '25.03');
    t.update('bitrate', '3102.5');
    t.update('total_size', '123456');
    t.update('speed', '1x');
    const snap = t.snapshot();
    expect(snap.frame).toBe(150);
    expect(snap.fps).toBe(25.03);
    expect(snap.bitrateKbps).toBe(3102.5);
    expect(snap.lastUpdateAt).toBeNull();

    t.update('progress', 'continue');
    expect(t.getLastUpdateAt()).not.toBeNull();
  });

  it('resets to zero', () => {
    const t = new ProgressTracker();
    t.update('frame', '50');
    t.reset();
    expect(t.snapshot().frame).toBe(0);
  });
});