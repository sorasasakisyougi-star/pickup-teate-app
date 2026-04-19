import assert from 'node:assert/strict';
import test from 'node:test';

import { forwardToPowerAutomate } from '../../lib/lineworks/forward';
import type { V1Payload } from '../../lib/lineworks/mapper';
import { buildV1Payload } from '../../lib/lineworks/mapper';
import { parseMessageBody } from '../../lib/lineworks/parse';

function fixturePayload(): V1Payload {
  const r = parseMessageBody(`#送迎
ハイエース
通常ルート
会社
A病院
215159
215185`);
  if (!r.ok) throw new Error('fixture bad');
  return buildV1Payload(r.data, {
    driverName: '山田太郎',
    messageTimestamp: new Date('2026-04-19T01:15:00Z'),
    fareYen: 700,
  });
}

type FakeCall = { url: string; body: unknown; headers: Record<string, string> };

function makeFakeFetch(statuses: number[]) {
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
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers,
    });
    const status = statuses[i] ?? statuses[statuses.length - 1];
    i++;
    return new Response('', { status });
  };
  return { fn, calls };
}

const noSleep = async () => {};

test('forward — returns webhook_url_missing when env unset and no option provided', async () => {
  const r = await forwardToPowerAutomate(fixturePayload(), {
    webhookUrl: '',
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error, 'webhook_url_missing');
  assert.equal(r.attempts, 0);
});

test('forward — 200 on first attempt', async () => {
  const { fn, calls } = makeFakeFetch([200]);
  const r = await forwardToPowerAutomate(fixturePayload(), {
    webhookUrl: 'https://flow.example.com/trigger',
    fetchImpl: fn,
    sleep: noSleep,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.status, 200);
  assert.equal(r.attempts, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://flow.example.com/trigger');
  assert.equal(calls[0].headers['content-type'], 'application/json');
  const body = calls[0].body as V1Payload;
  assert.equal(body.運転者, '山田太郎');
  assert.equal(body.到着１, 'A病院');
});

test('forward — retries transient 500 then succeeds on attempt 2', async () => {
  const { fn, calls } = makeFakeFetch([500, 202]);
  const r = await forwardToPowerAutomate(fixturePayload(), {
    webhookUrl: 'https://flow.example.com/trigger',
    fetchImpl: fn,
    sleep: noSleep,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.status, 202);
  assert.equal(r.attempts, 2);
  assert.equal(calls.length, 2);
});

test('forward — all attempts fail returns error with last status', async () => {
  const { fn, calls } = makeFakeFetch([502, 502, 502]);
  const r = await forwardToPowerAutomate(fixturePayload(), {
    webhookUrl: 'https://flow.example.com/trigger',
    fetchImpl: fn,
    sleep: noSleep,
    maxAttempts: 3,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, 502);
  assert.equal(r.attempts, 3);
  assert.equal(r.error, 'http_502');
  assert.equal(calls.length, 3);
});

test('forward — network error (throw) is retried', async () => {
  let calls = 0;
  const fn: typeof fetch = async () => {
    calls++;
    if (calls < 2) throw new Error('ECONNRESET');
    return new Response('', { status: 200 });
  };
  const r = await forwardToPowerAutomate(fixturePayload(), {
    webhookUrl: 'https://flow.example.com/trigger',
    fetchImpl: fn,
    sleep: noSleep,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.attempts, 2);
});

test('forward — maxAttempts=1 does not retry', async () => {
  const { fn, calls } = makeFakeFetch([500]);
  const r = await forwardToPowerAutomate(fixturePayload(), {
    webhookUrl: 'https://flow.example.com/trigger',
    fetchImpl: fn,
    sleep: noSleep,
    maxAttempts: 1,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.attempts, 1);
  assert.equal(calls.length, 1);
});
