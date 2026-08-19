const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@?&=+-]*$/.test(value) && value.length > 0) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Replace or append KEY=value lines. Unrelated lines (including comments) are
 * preserved. Does not parse shell expansions.
 */
export function upsertEnvVars(content: string, vars: Record<string, string>): string {
  let next = content;
  if (next.length > 0 && !next.endsWith('\n')) next += '\n';

  for (const [key, value] of Object.entries(vars)) {
    if (!ENV_KEY.test(key)) {
      throw new Error(`Invalid env key: ${key}`);
    }
    const line = `${key}=${quoteEnvValue(value)}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(next)) {
      next = next.replace(re, line);
    } else {
      next += `${line}\n`;
    }
  }
  return next;
}
