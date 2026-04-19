// Phase 2d-1: LINE WORKS Bot OAuth2 JWT flow + text reply.
//
// The OAuth details (token endpoint, scopes, endpoint URLs) are isolated
// here so the route handler stays orchestration-only. Secrets (token,
// client_secret, private_key) are NEVER logged.
//
// OAuth flow (LINE WORKS Bot API 2.0, Service Account JWT):
//   1. Build JWT  {alg:"RS256"}, {iss:client_id, sub:service_account,
//      iat, exp:iat+3600}, signed with the service account's private PEM
//   2. POST https://auth.worksmobile.com/oauth2/v2.0/token
//        grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
//        assertion=<jwt>&client_id=...&client_secret=...&scope=bot
//   3. Cache access_token until (now + expires_in - 60s)
//   4. POST https://www.worksapis.com/v1.0/bots/{botId}/users/{userId}/messages
//        Authorization: Bearer <token>
//        {content:{type:"text", text:"..."}}

import crypto from 'node:crypto';

const TOKEN_URL = 'https://auth.worksmobile.com/oauth2/v2.0/token';
const MESSAGE_URL = 'https://www.worksapis.com/v1.0/bots/{botId}/users/{userId}/messages';
const TOKEN_SAFETY_SEC = 60;
const DEFAULT_JWT_EXP_SEC = 3600;

export type BotClientConfig = {
  botId: string;
  clientId: string;
  clientSecret: string;
  serviceAccount: string;
  privateKeyPem: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. Returns ms epoch. */
  now?: () => number;
};

export type BotSendResult =
  | { ok: true; status: number }
  | { ok: false; status: number | null; error: string };

export type BotClient = {
  sendText(userId: string, text: string): Promise<BotSendResult>;
};

/**
 * Build the signed JWT assertion. Exported for unit testing; the token
 * flow below calls this internally.
 */
export function buildJwt(config: BotClientConfig, nowSec?: number): string {
  const iat = nowSec ?? Math.floor((config.now?.() ?? Date.now()) / 1000);
  const exp = iat + DEFAULT_JWT_EXP_SEC;
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iss: config.clientId, sub: config.serviceAccount, iat, exp };
  const b64url = (obj: object) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(signingInput)
    .sign(config.privateKeyPem);
  return `${signingInput}.${signature.toString('base64url')}`;
}

type CachedToken = { token: string; expiresAtMs: number };

export function createBotClient(config: BotClientConfig): BotClient {
  let cached: CachedToken | null = null;
  const doFetch = config.fetchImpl ?? fetch;
  const now = () => (config.now ? config.now() : Date.now());

  async function getToken(): Promise<string> {
    const ms = now();
    if (cached && cached.expiresAtMs > ms) return cached.token;

    const jwt = buildJwt(config, Math.floor(ms / 1000));
    const body = new URLSearchParams({
      assertion: jwt,
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: 'bot',
    }).toString();

    const res = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error(`token_fetch_failed_${res.status}`);

    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('token_response_missing_access_token');

    const expiresInSec = typeof json.expires_in === 'number' ? json.expires_in : 0;
    cached = {
      token: json.access_token,
      expiresAtMs: ms + Math.max(0, (expiresInSec - TOKEN_SAFETY_SEC) * 1000),
    };
    return cached.token;
  }

  async function sendText(userId: string, text: string): Promise<BotSendResult> {
    try {
      const token = await getToken();
      const url = MESSAGE_URL.replace('{botId}', encodeURIComponent(config.botId)).replace(
        '{userId}',
        encodeURIComponent(userId),
      );
      const res = await doFetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content: { type: 'text', text } }),
      });
      if (!res.ok) return { ok: false, status: res.status, error: `http_${res.status}` };
      return { ok: true, status: res.status };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'send_failed';
      return { ok: false, status: null, error: msg };
    }
  }

  return { sendText };
}

// --- Factory / feature-flag glue ------------------------------------------

let factoryOverride: (() => BotClient | null) | null = null;

/** Test-only: replace the env-backed factory with an arbitrary function. */
export function __setBotClientFactoryForTests(
  fn: (() => BotClient | null) | null,
): void {
  factoryOverride = fn;
}

/**
 * Construct a BotClient from env vars, gated on LW_BOT_REPLY_ENABLED=1.
 * Returns null when the feature is disabled or when any required env is
 * absent (we log a warning but never block the calling flow).
 */
export function createBotClientFromEnv(): BotClient | null {
  if (factoryOverride) return factoryOverride();
  if (process.env.LW_BOT_REPLY_ENABLED !== '1') return null;

  const botId = process.env.LW_BOT_ID?.trim() || '';
  const clientId = process.env.LW_CLIENT_ID?.trim() || '';
  const clientSecret = process.env.LW_CLIENT_SECRET?.trim() || '';
  const serviceAccount = process.env.LW_SERVICE_ACCOUNT?.trim() || '';
  const privateKeyRaw = process.env.LW_PRIVATE_KEY_PEM?.trim() || '';

  const missing: string[] = [];
  if (!botId) missing.push('LW_BOT_ID');
  if (!clientId) missing.push('LW_CLIENT_ID');
  if (!clientSecret) missing.push('LW_CLIENT_SECRET');
  if (!serviceAccount) missing.push('LW_SERVICE_ACCOUNT');
  if (!privateKeyRaw) missing.push('LW_PRIVATE_KEY_PEM');
  if (missing.length > 0) {
    console.warn(
      `[lw/bot] LW_BOT_REPLY_ENABLED=1 but required envs are missing: ${missing.join(', ')}`,
    );
    return null;
  }

  return createBotClient({
    botId,
    clientId,
    clientSecret,
    serviceAccount,
    // PEMs are commonly stored in .env with escaped \n — decode back to real newlines.
    privateKeyPem: privateKeyRaw.replace(/\\n/g, '\n'),
  });
}
