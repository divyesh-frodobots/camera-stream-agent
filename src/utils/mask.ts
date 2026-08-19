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