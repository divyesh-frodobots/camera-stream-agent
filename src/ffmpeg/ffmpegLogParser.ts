export interface FfmpegProgress {
  frame: number;
  fps: number;
  bitrateKbps: number;
  totalSizeBytes: number;
  outTimeMicros: number;
  speed: number;
}

export interface ParsedFfmpegLine {
  kind: 'progress' | 'error' | 'warning' | 'info';
  line: string;
  progressKey?: string;
  progressValue?: string;
  errorCategory?: FfmpegErrorCategory;
}

export type FfmpegErrorCategory =
  | 'rtsp_connect'
  | 'rtmp_connect'
  | 'auth'
  | 'not_found'
  | 'invalid_data'
  | 'no_input'
  | 'generic';

const ERROR_PATTERNS: Array<{ category: FfmpegErrorCategory; pattern: RegExp }> = [
  {
    category: 'rtmp_connect',
    pattern: /(rtmp[\s:/].*(connection|error|failed|timeout))|(error.*rtmp)|(could not open rtmp)|(rtmp server.*(closed|refused))/i,
  },
  {
    category: 'rtsp_connect',
    pattern: /(rtsp[\s:/].*(connection|refused|reset|timed out|closed|error|failed|timeout))|(could not connect.*server)|(unable to open|failed to connect).*rtsp/i,
  },
  { category: 'auth', pattern: /(401|403|unauthorized|permission denied|authentication failed)/i },
  { category: 'not_found', pattern: /(404|not found|no such file|failed to open|server returned)/i },
  { category: 'invalid_data', pattern: /(invalid data|invalid frame|corrupt|malformed|bad header|error while decoding)/i },
  { category: 'no_input', pattern: /(could not open input|no such stream|no input)/i },
];

/**
 * Parses a single FFmpeg log line. Progress comes from the machine-readable
 * `-progress pipe:1` output ("key=value" blocks), errors from stderr.
 */
export function parseFfmpegLine(rawLine: string): ParsedFfmpegLine {
  const line = rawLine.replace(/\r?\n$/, '');
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'info', line: '' };

  // Progress output: key=value pairs, one per line, terminated by progress=continue|end
  const progressMatch = /^(frame|fps|bitrate|total_size|out_time_us|out_time_ms|speed|progress)=(.+)$/.exec(trimmed);
  if (progressMatch) {
    return { kind: 'progress', line: trimmed, progressKey: progressMatch[1]!, progressValue: progressMatch[2]! };
  }

  for (const { category, pattern } of ERROR_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { kind: 'error', line: trimmed, errorCategory: category };
    }
  }

  return { kind: 'info', line: trimmed };
}

/** Accumulates progress key/value pairs into a snapshot. */
export class ProgressTracker {
  private frame = 0;
  private fps = 0;
  private bitrate = 0;
  private totalSize = 0;
  private outTimeMicros = 0;
  private speed = 0;
  private lastUpdateAt: number | null = null;

  update(key: string, value: string): void {
    switch (key) {
      case 'frame':
        this.frame = Number(value) || 0;
        break;
      case 'fps':
        this.fps = Number(value) || 0;
        break;
      case 'bitrate':
        this.bitrate = Number(value) || 0;
        break;
      case 'total_size':
        this.totalSize = Number(value) || 0;
        break;
      case 'out_time_us':
      case 'out_time_ms':
        this.outTimeMicros = Number(value) || 0;
        break;
      case 'speed':
        this.speed = Number(value) || 0;
        break;
      case 'progress':
        if (value === 'continue') this.lastUpdateAt = Date.now();
        break;
    }
  }

  snapshot(): FfmpegProgress & { lastUpdateAt: number | null } {
    return {
      frame: this.frame,
      fps: this.fps,
      bitrateKbps: this.bitrate,
      totalSizeBytes: this.totalSize,
      outTimeMicros: this.outTimeMicros,
      speed: this.speed,
      lastUpdateAt: this.lastUpdateAt,
    };
  }

  getLastUpdateAt(): number | null {
    return this.lastUpdateAt;
  }

  reset(): void {
    this.frame = 0;
    this.fps = 0;
    this.bitrate = 0;
    this.totalSize = 0;
    this.outTimeMicros = 0;
    this.speed = 0;
    this.lastUpdateAt = null;
  }
}