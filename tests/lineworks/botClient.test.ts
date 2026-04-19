import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  buildJwt,
  createBotClient,
  createBotClientFromEnv,
  __setBotClientFactoryForTests,
} from '../../lib/lineworks/botClient';

function generateRsaKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

const baseConfig = () => {
  const { publicKey, privateKey } = generateRsaKeyPair();
  return {
    publicKey,
    privateKey,
    cfg: {
      botId: 'bot-test',
      clientId: 'client-abc',
      clientSecret: 'secret-def',
      serviceAccount: 'sa@example.com',
      privateKeyPem: privateKey,
    },
  };
};

// --- JWT signature --------------------------------------------------------

test('buildJwt produces three base64url parts with valid RS256 signature', () => {
  const { publicKey, cfg } = baseConfig();
  const jwt = buildJwt(cfg, 1_700_000_000);
  const parts = jwt.split('.');
  assert.equal(parts.length, 3);

  const headerJson = Buffer.from(parts[0], 'base64url').toString('utf8');
  const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
  const header = JSON.parse(headerJson);
  const payload = JSON.parse(payloadJson);
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  assert.equal(payload.iss, 'client-abc');
  assert.equal(payload.sub, 'sa@example.com');
  assert.equal(payload.iat, 1_700_000_000);
  assert.equal(payload.exp, 1_700_000_000 + 3600);

  const signingInput = `${parts[0]}.${parts[1]}`;
  const signature = Buffer.from(parts[2], 'base64url');
  const verified = crypto
    .createVerify('RSA-SHA256')
    .update(signingInput)
    .verify(publicKey, signature);
  assert.equal(verified, true);
});

// --- Token + sendText happy path -----------------------------------------

type FakeCall = { url: string; body: string; headers: Record<string, string> };

function makeFakeFetch(responses: Array<{ status: number; json?: unknown; text?: string }>) {
  const calls: FakeCall[] = [];
  let i = 0;
  const fn: typeof fetch = async (url, init) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
    }
    calls.push({
      url: typeof url === 'string' ? url : String(url),
      body: typeof init?.body === 'string' ? init.body : String(init?.body ?? ''),
      headers,
    });
    const r = responses[i] ?? responses[responses.length - 1];
    i++;
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fn, calls };
}

test('sendText: first call fetches token, second call reuses cached token', async () => {
  const { cfg } = baseConfig();
  const fake = makeFakeFetch([
    { status: 200, json: { access_token: 'tok-1', expires_in: 3600 } },
    { status: 200, json: {} },
    { status: 200, json: {} },
  ]);
  const client = createBotClient({ ...cfg, fetchImpl: fake.fn, now: () => 1_700_000_000_000 });

  const r1 = await client.sendText('user-1', 'hello');
  assert.equal(r1.ok, true);
  const r2 = await client.sendText('user-2', 'world');
  assert.equal(r2.ok, true);

  assert.equal(fake.calls.length, 3, 'expected 1 token + 2 sends, no second token fetch');
  assert.ok(fake.calls[0].url.endsWith('/oauth2/v2.0/token'));
  assert.ok(fake.calls[1].url.includes('/bots/bot-test/users/user-1/messages'));
  assert.ok(fake.calls[2].url.includes('/bots/bot-test/users/user-2/messages'));
});

test('sendText: cache expires and triggers token refetch after safety margin', async () => {
  const { cfg } = baseConfig();
  let nowMs = 1_700_000_000_000;
  const fake = makeFakeFetch([
    { status: 200, json: { access_token: 'tok-old', expires_in: 120 } },
    { status: 200, json: {} },
    { status: 200, json: { access_token: 'tok-new', expires_in: 3600 } },
    { status: 200, json: {} },
  ]);
  const client = createBotClient({ ...cfg, fetchImpl: fake.fn, now: () => nowMs });

  await client.sendText('u', 'a');
  nowMs += 120_000; // past (expires_in - safety) = 60s
  await client.sendText('u', 'b');

  assert.equal(fake.calls.length, 4);
  assert.ok(fake.calls[0].url.endsWith('/oauth2/v2.0/token'));
  assert.ok(fake.calls[2].url.endsWith('/oauth2/v2.0/token'));
  assert.ok(fake.calls[1].headers.authorization!.endsWith('tok-old'));
  assert.ok(fake.calls[3].headers.authorization!.endsWith('tok-new'));
});

test('sendText: POST body and headers match LW API contract', async () => {
  const { cfg } = baseConfig();
  const fake = makeFakeFetch([
    { status: 200, json: { access_token: 'tok', expires_in: 3600 } },
    { status: 200, json: {} },
  ]);
  const client = createBotClient({ ...cfg, fetchImpl: fake.fn });
  await client.sendText('c72af563-0f21-4736-11e4-045237113344', '送迎記録を登録しました');

  const tokenReq = fake.calls[0];
  assert.equal(tokenReq.headers['content-type'], 'application/x-www-form-urlencoded');
  const tokenBody = new URLSearchParams(tokenReq.body);
  assert.equal(tokenBody.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.equal(tokenBody.get('client_id'), 'client-abc');
  assert.equal(tokenBody.get('client_secret'), 'secret-def');
  assert.equal(tokenBody.get('scope'), 'bot');
  assert.ok((tokenBody.get('assertion') ?? '').split('.').length === 3);

  const msgReq = fake.calls[1];
  assert.equal(msgReq.headers['content-type'], 'application/json');
  assert.equal(msgReq.headers.authorization, 'Bearer tok');
  const msgBody = JSON.parse(msgReq.body);
  assert.deepEqual(msgBody, { content: { type: 'text', text: '送迎記録を登録しました' } });
  assert.ok(msgReq.url.includes('/bots/bot-test/users/'));
});

// --- Failure paths --------------------------------------------------------

test('sendText: token endpoint non-2xx → {ok:false, error:token_fetch_failed_*}', async () => {
  const { cfg } = baseConfig();
  const fake = makeFakeFetch([{ status: 401, json: { error: 'unauthorized' } }]);
  const client = createBotClient({ ...cfg, fetchImpl: fake.fn });
  const r = await client.sendText('u', 'x');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /token_fetch_failed_401/);
});

test('sendText: message endpoint non-2xx → {ok:false, status, error:http_*}', async () => {
  const { cfg } = baseConfig();
  const fake = makeFakeFetch([
    { status: 200, json: { access_token: 'tok', expires_in: 3600 } },
    { status: 403, json: {} },
  ]);
  const client = createBotClient({ ...cfg, fetchImpl: fake.fn });
  const r = await client.sendText('u', 'x');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, 403);
  assert.equal(r.error, 'http_403');
});

test('sendText: network error → {ok:false, status:null}', async () => {
  const { cfg } = baseConfig();
  const fn: typeof fetch = async () => {
    throw new Error('ECONNRESET');
  };
  const client = createBotClient({ ...cfg, fetchImpl: fn });
  const r = await client.sendText('u', 'x');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, null);
  assert.equal(r.error, 'ECONNRESET');
});

// --- Factory gating -------------------------------------------------------

test('createBotClientFromEnv returns null when LW_BOT_REPLY_ENABLED not set', () => {
  __setBotClientFactoryForTests(null);
  delete process.env.LW_BOT_REPLY_ENABLED;
  assert.equal(createBotClientFromEnv(), null);
});

test('createBotClientFromEnv returns null when required envs missing', () => {
  __setBotClientFactoryForTests(null);
  process.env.LW_BOT_REPLY_ENABLED = '1';
  delete process.env.LW_BOT_ID;
  delete process.env.LW_CLIENT_ID;
  delete process.env.LW_CLIENT_SECRET;
  delete process.env.LW_SERVICE_ACCOUNT;
  delete process.env.LW_PRIVATE_KEY_PEM;
  assert.equal(createBotClientFromEnv(), null);
});

test('createBotClientFromEnv honours the test factory override', () => {
  const fake = { sendText: async () => ({ ok: true as const, status: 200 }) };
  __setBotClientFactoryForTests(() => fake);
  assert.equal(createBotClientFromEnv(), fake);
  __setBotClientFactoryForTests(null);
});
