export interface ViewerSession {
  appId: string;
  channel: string;
  uid: number;
  token: string;
  expiresAt: string;
}

export type ViewerSessionResult =
  | { ok: true; session: ViewerSession }
  | { ok: false; message: string };

const PULL_HINT = 'Run npm run pull-local-config first';

function nonempty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function readViewerSessionFromEnv(env: {
  AGORA_APP_ID?: string;
  AGORA_CHANNEL?: string;
  AGORA_RTC_TOKEN?: string;
  AGORA_RTC_TOKEN_EXPIRES_AT?: string;
}): ViewerSessionResult {
  const appId = nonempty(env.AGORA_APP_ID);
  const channel = nonempty(env.AGORA_CHANNEL);
  const token = nonempty(env.AGORA_RTC_TOKEN);
  const expiresAt = nonempty(env.AGORA_RTC_TOKEN_EXPIRES_AT);

  if (!appId || !channel || !token || !expiresAt) {
    return { ok: false, message: `Missing cached Agora viewer fields. ${PULL_HINT}` };
  }

  const expiresMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresMs) || expiresMs <= Date.now()) {
    return {
      ok: false,
      message: `Cached Agora viewer token is missing or expired. ${PULL_HINT}`,
    };
  }

  return {
    ok: true,
    session: { appId, channel, uid: 0, token, expiresAt },
  };
}
