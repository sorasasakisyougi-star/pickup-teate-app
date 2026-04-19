// Direct handler invocation tests for POST /api/lw/process-inbox.
// Covers auth + config gates + empty-inbox happy path. The full
// parse→enrich→map→forward pipeline is exercised by process.test.ts — here
// we only prove the HTTP layer wires auth, config, and DB access correctly.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { NextRequest } from 'next/server';

import { insertInbox, getInboxByHash } from '../../lib/lineworks/inbox';
import {
  __setBotClientFactoryForTests,
  type BotClient,
} from '../../lib/lineworks/botClient';

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-proc-route-'));
  return path.join(dir, 'test.db');
}

async function loadRoute() {
  const mod = await import('../../app/api/lw/process-inbox/route');
  return mod as {
    POST: (req: NextRequest) => Promise<Response>;
    GET: () => Promise<Response>;
  };
}

function makeReq(headers: Record<string, string>, body: string = '{}'): NextRequest {
  const req = new Request('http://localhost/api/lw/process-inbox', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  return req as unknown as NextRequest;
}

function setStandardEnv() {
  process.env.ADMIN_KEY = 'test-admin-key';
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  process.env.LW_INBOX_DB_PATH = tempDbPath();
}

test('POST 503 when ADMIN_KEY not configured', async () => {
  delete process.env.ADMIN_KEY;
  const { POST } = await loadRoute();
  const res = await POST(makeReq({}));
  assert.equal(res.status, 503);
  const json = await res.json();
  assert.equal(json.error, 'admin_key_not_configured');
});

test('POST 401 when admin key missing', async () => {
  setStandardEnv();
  const { POST } = await loadRoute();
  const res = await POST(makeReq({}));
  assert.equal(res.status, 401);
  const json = await res.json();
  assert.equal(json.error, 'unauthorized');
});

test('POST 401 when admin key wrong', async () => {
  setStandardEnv();
  const { POST } = await loadRoute();
  const res = await POST(makeReq({ 'x-admin-key': 'wrong' }));
  assert.equal(res.status, 401);
});

test('POST accepts Bearer authorization header', async () => {
  setStandardEnv();
  const { POST } = await loadRoute();
  const res = await POST(makeReq({ authorization: 'Bearer test-admin-key' }));
  assert.equal(res.status, 200);
});

test('POST 503 when SUPABASE_URL missing', async () => {
  setStandardEnv();
  delete process.env.SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  const { POST } = await loadRoute();
  const res = await POST(makeReq({ 'x-admin-key': 'test-admin-key' }));
  assert.equal(res.status, 503);
  const json = await res.json();
  assert.equal(json.error, 'supabase_url_missing');
});

test('POST 503 when SUPABASE_SERVICE_ROLE_KEY missing', async () => {
  setStandardEnv();
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const { POST } = await loadRoute();
  const res = await POST(makeReq({ 'x-admin-key': 'test-admin-key' }));
  assert.equal(res.status, 503);
  const json = await res.json();
  assert.equal(json.error, 'supabase_service_role_key_missing');
});

test('POST 200 with zeros when inbox is empty', async () => {
  setStandardEnv();
  const { POST } = await loadRoute();
  const res = await POST(
    makeReq({ 'x-admin-key': 'test-admin-key' }, JSON.stringify({ limit: 5 })),
  );
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.processed, 0);
  assert.equal(json.skipped, 0);
  assert.equal(json.forwarded, 0);
  assert.equal(json.invalid, 0);
  assert.equal(json.failed, 0);
  assert.deepEqual(json.details, []);
});

test('POST 200 with clamped limit when body.limit > MAX', async () => {
  setStandardEnv();
  const { POST } = await loadRoute();
  const res = await POST(
    makeReq({ 'x-admin-key': 'test-admin-key' }, JSON.stringify({ limit: 99999 })),
  );
  assert.equal(res.status, 200);
});

test('POST 200 with bad body JSON falls back to default limit', async () => {
  setStandardEnv();
  const { POST } = await loadRoute();
  const req = new Request('http://localhost/api/lw/process-inbox', {
    method: 'POST',
    headers: { 'x-admin-key': 'test-admin-key' },
    body: 'not-json',
  });
  const res = await POST(req as unknown as NextRequest);
  assert.equal(res.status, 200);
});

test('GET 405', async () => {
  const { GET } = await loadRoute();
  const res = await GET();
  assert.equal(res.status, 405);
});

// --- Phase 2d-1: Bot reply wiring -----------------------------------------

function makeFakeBot(result:
  | { ok: true; status: 200 }
  | { ok: false; status: number | null; error: string }
): { client: BotClient; calls: Array<{ userId: string; text: string }> } {
  const calls: Array<{ userId: string; text: string }> = [];
  const client: BotClient = {
    async sendText(userId, text) {
      calls.push({ userId, text });
      return result;
    },
  };
  return { client, calls };
}

function seedInboxRow(dbPath: string, rawBodyJson: string, hash = 'h-1') {
  insertInbox(
    {
      messageHash: hash,
      messageId: 'msg-1',
      botId: 'bot-pickup-test',
      eventType: 'message',
      rawBody: rawBodyJson,
    },
    dbPath,
  );
  return hash;
}

function rawWebhookBody(
  text: string,
  userId = 'uuid-unknown', // invalid path by default
) {
  return JSON.stringify({
    type: 'message',
    source: { userId },
    issuedTime: '2026-04-19T01:15:00Z',
    content: { type: 'text', text, messageId: 'msg-1' },
  });
}

test('replyStatus=disabled when LW_BOT_REPLY_ENABLED off and no override', async () => {
  setStandardEnv();
  const dbPath = process.env.LW_INBOX_DB_PATH!;
  const hash = seedInboxRow(dbPath, rawWebhookBody('#送迎\nハイエース\n通常ルート\n会社\nA病院\n100\n150'));
  __setBotClientFactoryForTests(null); // no override → factory honours env (off)
  delete process.env.LW_BOT_REPLY_ENABLED;

  const { POST } = await loadRoute();
  const res = await POST(makeReq({ 'x-admin-key': 'test-admin-key' }));
  assert.equal(res.status, 200);
  const json = (await res.json()) as {
    details: Array<{ messageHash: string; terminal: string; replyStatus: string }>;
  };
  const detail = json.details.find((d) => d.messageHash === hash)!;
  assert.equal(detail.replyStatus, 'disabled');
});

test('invalid → Bot reply sends outcome.userMessage', async () => {
  setStandardEnv();
  const dbPath = process.env.LW_INBOX_DB_PATH!;
  // driver_user_id_not_registered path: body is valid, but uuid-unknown
  // doesn't resolve against Supabase (the route uses a real Supabase
  // client which will fail; we'd normally mock but here we rely on the
  // process layer failing BEFORE the Supabase call — specifically on the
  // 運転者解決 step, which throws "drivers_query_failed" because the
  // fake Supabase URL has no server. To avoid that flakiness, we seed
  // with a body that is invalid at PARSE time (unknown trailing line) so
  // invalid is returned before any Supabase call.
  const invalidBody = '#送迎\nハイエース\n通常ルート\n会社\nA病院\n100\n150\n何か';
  const hash = seedInboxRow(dbPath, rawWebhookBody(invalidBody, 'uuid-driver-1'));
  const bot = makeFakeBot({ ok: true, status: 200 });
  __setBotClientFactoryForTests(() => bot.client);

  const { POST } = await loadRoute();
  const res = await POST(makeReq({ 'x-admin-key': 'test-admin-key' }));
  assert.equal(res.status, 200);
  const json = (await res.json()) as {
    details: Array<{
      messageHash: string;
      terminal: string;
      code?: string;
      userMessage?: string;
      replyStatus: string;
    }>;
  };
  const detail = json.details.find((d) => d.messageHash === hash)!;
  assert.equal(detail.terminal, 'invalid');
  assert.equal(detail.code, 'invalid_format');
  assert.equal(bot.calls.length, 1);
  assert.equal(bot.calls[0].userId, 'uuid-driver-1');
  assert.equal(bot.calls[0].text, detail.userMessage);

  __setBotClientFactoryForTests(null);
});

test('reply failure does NOT change persisted inbox status (status stays invalid)', async () => {
  setStandardEnv();
  const dbPath = process.env.LW_INBOX_DB_PATH!;
  const invalidBody = '#送迎\nハイエース\n特別\n会社\nA病院\n100\n150';
  const hash = seedInboxRow(dbPath, rawWebhookBody(invalidBody, 'uuid-driver-1'));
  const bot = makeFakeBot({ ok: false, status: 503, error: 'http_503' });
  __setBotClientFactoryForTests(() => bot.client);

  const { POST } = await loadRoute();
  const res = await POST(makeReq({ 'x-admin-key': 'test-admin-key' }));
  assert.equal(res.status, 200);
  const json = (await res.json()) as {
    details: Array<{
      messageHash: string;
      terminal: string;
      replyStatus: string;
      replyError?: string;
    }>;
  };
  const detail = json.details.find((d) => d.messageHash === hash)!;
  assert.equal(detail.terminal, 'invalid');
  assert.equal(detail.replyStatus, 'failed');
  assert.equal(detail.replyError, 'http_503');

  // Persisted status must be 'invalid' — reply failure does NOT roll it back.
  const row = getInboxByHash(hash, dbPath);
  assert.equal(row!.status, 'invalid');
  __setBotClientFactoryForTests(null);
});

test('replyStatus=skipped when outcome has no userMessage (not_a_soutei_message)', async () => {
  setStandardEnv();
  const dbPath = process.env.LW_INBOX_DB_PATH!;
  const hash = seedInboxRow(dbPath, rawWebhookBody('こんにちは', 'uuid-driver-1'));
  const bot = makeFakeBot({ ok: true, status: 200 });
  __setBotClientFactoryForTests(() => bot.client);

  const { POST } = await loadRoute();
  const res = await POST(makeReq({ 'x-admin-key': 'test-admin-key' }));
  assert.equal(res.status, 200);
  const json = (await res.json()) as {
    details: Array<{ messageHash: string; terminal: string; code?: string; replyStatus: string }>;
  };
  const detail = json.details.find((d) => d.messageHash === hash)!;
  assert.equal(detail.terminal, 'invalid');
  assert.equal(detail.code, 'not_a_soutei_message');
  assert.equal(detail.replyStatus, 'skipped');
  assert.equal(bot.calls.length, 0);

  __setBotClientFactoryForTests(null);
});
