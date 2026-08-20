/** Keep only the trailing characters of a sensitive value for log correlation. */
export function maskSecret(value: string | null | undefined, visibleChars = 4): string {
  if (!value) return '<none>';
  if (value.length <= visibleChars) return '<redacted>';
  return `***${value.slice(-visibleChars)}`;
}

/** Redact credentials inside a URL (e.g. rtsp://user:pass@host/path). */
export function maskUrl(url: string | null | undefined): string {
  if (!url) return '<none>';
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '***';
    }
    return u.toString();
  } catch {
    return '<invalid-url>';
  }
}

/** Redact credentials and the stream-key pathname segment of an RTMP publish URL. */
export function maskRtmpUrl(url: string | null | undefined): string {
  if (!url) return '<none>';
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '***';
    }

    const segments = u.pathname.split('/').filter((segment) => segment.length > 0);
    if (segments.length > 0) {
      const lastIndex = segments.length - 1;
      segments[lastIndex] = maskSecret(segments[lastIndex]);
      u.pathname = `/${segments.join('/')}`;
    }

    for (const key of [...u.searchParams.keys()]) {
      u.searchParams.set(key, '[REDACTED]');
    }
    u.hash = '';

    return u.toString();
  } catch {
    return maskUrl(url);
  }
}