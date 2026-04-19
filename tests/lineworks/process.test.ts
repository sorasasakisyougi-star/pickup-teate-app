import assert from 'node:assert/strict';
import test from 'node:test';

import { processInboxRow } from '../../lib/lineworks/process';
import type {
  EnrichDbClient,
  NamedRow,
  FareRow,
  RouteDistanceRow,
} from '../../lib/lineworks/enrich';
import type { V1Payload } from '../../lib/lineworks/mapper';
import type { ForwardResult } from '../../lib/lineworks/forward';

type DriverFixture = NamedRow & { lineworks_user_id?: string | null };

function makeDb(init: {
  drivers?: DriverFixture[];
  locations?: NamedRow[];
  fares?: FareRow[];
  routeDistances?: RouteDistanceRow[];
}): EnrichDbClient {
  const drivers = init.drivers ?? [];
  const locations = init.locations ?? [];
  const fares = init.fares ?? [];
  const routes = init.routeDistances ?? [];
  return {
    async findDriverByName(name) {
      return drivers.find((d) => d.name === name) ?? null;
    },
    async findDriverByLineWorksUserId(userId) {
      const d = drivers.find((x) => x.lineworks_user_id === userId);
      return d ? { id: d.id, name: d.name } : null;
    },
    async findLocationByName(name) {
      return locations.find((l) => l.name === name) ?? null;
    },
    async findFare(fromId, toId) {
      return fares.find((f) => f.from_id === fromId && f.to_id === toId) ?? null;
    },
    async findRouteDistance(fromId, toId) {
      return (
        routes.find((r) => r.from_location_id === fromId && r.to_location_id === toId) ?? null
      );
    },
  };
}

function makeForward(result: ForwardResult) {
  const calls: V1Payload[] = [];
  return {
    calls,
    fn: async (payload: V1Payload) => {
      calls.push(payload);
      return result;
    },
  };
}

function body(
  text: string,
  opts: { userId?: string; issuedTime?: string | number } = {},
) {
  return JSON.stringify({
    type: 'message',
    source: { userId: opts.userId ?? 'uuid-driver-1' },
    issuedTime: opts.issuedTime ?? '2026-04-19T01:15:00Z',
    content: { type: 'text', text, messageId: 'msg-1' },
  });
}

const ISO_FALLBACK = '2026-04-19T01:15:00Z';

const STANDARD_DB = () =>
  makeDb({
    drivers: [{ id: 10, name: '山田太郎', lineworks_user_id: 'uuid-driver-1' }],
    locations: [
      { id: 1, name: '会社' },
      { id: 2, name: 'A病院' },
      { id: 3, name: 'B老人ホーム' },
    ],
    fares: [
      { from_id: 1, to_id: 2, amount_yen: 700 },
      { from_id: 2, to_id: 3, amount_yen: 500 },
    ],
    routeDistances: [
      { from_location_id: 1, to_location_id: 2, distance_km: 5.2 },
      { from_location_id: 2, to_location_id: 3, distance_km: 3.1 },
    ],
  });

test('full pipeline: 通常ルート → forwarded with payload', async () => {
  const f = makeForward({ ok: true, status: 200, attempts: 1 });
  const r = await processInboxRow(
    body(`#送迎
ハイエース
通常ルート
会社
A病院
B老人ホーム
215159
215185`),
    ISO_FALLBACK,
    { db: STANDARD_DB(), forward: f.fn },
  );
  assert.equal(r.terminal, 'forwarded');
  if (r.terminal !== 'forwarded') return;
  // Phase 2c-rev-fix: receiptId is null (HTTP 200 wasn't a meaningful receipt).
  assert.equal(r.receiptId, null);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].運転者, '山田太郎');
  assert.equal(f.calls[0]['金額（円）'], 1200);
  // Per Phase 2c-fix-1: total = sum of segment distances from route_distances.
  assert.equal(f.calls[0]['距離（始）〜到着１'], 5.2);
  assert.equal(f.calls[0]['距離（到着１〜到着２）'], 3.1);
  assert.equal(Number(f.calls[0]['総走行距離（km）']).toFixed(1), '8.3');
  assert.equal(f.calls[0].日付, '2026/4/19 10:15');
});

test('full pipeline: バス → forwarded with fare=2000', async () => {
  const f = makeForward({ ok: true, status: 202, attempts: 1 });
  const r = await processInboxRow(
    body(`#送迎
ハイエース
バス
-
A病院
215159
215185`),
    ISO_FALLBACK,
    { db: STANDARD_DB(), forward: f.fn },
  );
  assert.equal(r.terminal, 'forwarded');
  if (r.terminal !== 'forwarded') return;
  assert.equal(f.calls[0]['金額（円）'], 2000);
  assert.equal(f.calls[0].バス, 'バス');
});

test('invalid: not_a_soutei_message (no #送迎 header)', async () => {
  const f = makeForward({ ok: true, status: 200, attempts: 1 });
  const r = await processInboxRow(
    body('こんにちは'),
    ISO_FALLBACK,
    { db: STANDARD_DB(), forward: f.fn },
  );
  assert.equal(r.terminal, 'invalid');
  if (r.terminal !== 'invalid') return;
  assert.equal(r.code, 'not_a_soutei_message');
  assert.equal(f.calls.length, 0);
});

test('invalid: driver_user_id_not_registered → LINE WORKS ユーザーID未登録です', async () => {
  const f = makeForward({ ok: true, status: 200, attempts: 1 });
  const r = await processInboxRow(
    body(
      `#送迎
ハイエース
通常ルート
会社
A病院
100
150`,
      { userId: 'uuid-unknown' },
    ),
    ISO_FALLBACK,
    { db: STANDARD_DB(), forward: f.fn },
  );
  assert.equal(r.terminal, 'invalid');
  if (r.terminal !== 'invalid') return;
  assert.equal(r.code, 'driver_user_id_not_registered');
  assert.equal(r.userMessage, 'LINE WORKS ユーザーID未登録です');
  assert.equal(f.calls.length, 0);
});

test('invalid: location_not_registered for 通常ルート', async () => {
  const f = makeForward({ ok: true, status: 200, attempts: 1 });
  const r = await processInboxRow(
    body(`#送迎
ハイエース
通常ルート
会社
未登録の場所
100
150`),
    ISO_FALLBACK,
    { db: STANDARD_DB(), forward: f.fn },
  );
  assert.equal(r.terminal, 'invalid');
  if (r.terminal !== 'invalid') return;
  assert.equal(r.code, 'location_not_registered');
  assert.equal(r.userMessage, '場所名が未登録です');
});

test('invalid: too_many_arrivals surfaces Bot reply', async () => {
  const f = makeForward({ ok: true, status: 200, attempts: 1 });
  const r = await processInboxRow(
    body(`#送迎
ハイエース
通常ルート
会社
A
B
C
D
E
F
G
H
I
100
200`),
    ISO_FALLBACK,
    { db: STANDARD_DB(), forward: f.fn },
  );
  assert.equal(r.terminal, 'invalid');
  if (r.terminal !== 'invalid') return;
  assert.equal(r.code, 'too_many_arrivals');
  assert.equal(r.userMessage, '到着地は最大8件です');
});

test('invalid: missing_odo surfaces Bot reply', async () => {
  const f = makeForward({ ok: true, status: 200, attempts: 1 });
  const r = await processInboxRow(
    body(`#送迎
ハイエース
通常ルート
会社
A病院
B
C
100`),
    ISO_FALLBACK,
    { db: STANDARD_DB(), forward: f.fn },
  );
  assert.equal(r.terminal, 'invalid');
  if (r.terminal !== 'invalid') return;
  assert.equal(r.code, 'missing_odo');
  assert.equal(r.userMessage, 'ODO始/ODO終がありません');
});

test('invalid: distance_not_registered when a route_distances leg is missing', async () => {
  const db = makeDb({
    drivers: [{ id: 10, name: '山田太郎', lineworks_user_id: 'uuid-driver-1' }],
    locations: [
      { id: 1, name: '会社' },
      { id: 2, name: 'A病院' },
      { id: 3, name: 'B老人ホーム' },
    ],
    fares: [
      { from_id: 1, to_id: 2, amount_yen: 700 },
      { from_id: 2, to_id: 3, amount_yen: 500 },
    ],
    routeDistances: [{ from_location_id: 1, to_location_id: 2, distance_km: 5.2 }], // no 2↔3
  });
  const f = makeForward({ ok: true, status: 200, attempts: 1 });
  const r = await processInboxRow(
    body(`#送迎
ハイエース
通常ルート
会社
A病院
B老人ホーム
100
200`),
    ISO_FALLBACK,
    { db, forward: f.fn },
  );
  assert.equal(r.terminal, 'invalid');
  if (r.terminal !== 'invalid') return;
  assert.equal(r.code, 'distance_not_registered');
  assert.equal(r.userMessage, '区間距離マスタが未登録です');
  assert.equal(f.calls.length, 0);
});

test('バス: skips route_distances lookup (fromId may be null)', async () => {
  const f = makeForward({ ok: true, status: 200, attempts: 1 });
  const db = makeDb({
    drivers: [{ id: 10, name: '山田太郎', lineworks_user_id: 'uuid-driver-1' }],
    locations: [{ id: 2, name: 'A病院' }],
    // intentionally no route_distances — must not block bus flow
  });
  const r = await processInboxRow(
    body(`#送迎
ハイエース
バス
-
A病院
100
150`),
    ISO_FALLBACK,
    { db, forward: f.fn },
  );
  assert.equal(r.terminal, 'forwarded');
  if (r.terminal !== 'forwarded') return;
  // Bus: no segment distances; total falls back to odoEnd-odoStart.
  assert.equal(f.calls[0]['距離（始）〜到着１'], '');
  assert.equal(f.calls[0]['総走行距離（km）'], 50);
});

test('invalid: fare_not_registered when a leg fare is missing', async () => {
  const db = makeDb({
    drivers: [{ id: 10, name: '山田太郎', lineworks_user_id: 'uuid-driver-1' }],
    locations: [
      { id: 1, name: '会社' },
      { id: 2, name: 'A病院' },
      { id: 3, name: 'B老人ホーム' },
    ],
    fares: [{ from_id: 1, to_id: 2, amount_yen: 700 }], // no 2↔3
  });
  const f = makeForward({ ok: true, status: 200, attempts: 1 });
  const r = await processInboxRow(
    body(`#送迎
ハイエース
通常ルート
会社
A病院
B老人ホーム
100
200`),
    ISO_FALLBACK,
    { db, forward: f.fn },
  );
  assert.equal(r.terminal, 'invalid');
  if (r.terminal !== 'invalid') return;
  assert.equal(r.code, 'fare_not_registered');
});

test('invalid: missing_sender_user_id when source.userId is absent', async () => {
  const raw = JSON.stringify({
    type: 'message',
    source: {},
    issuedTime: '2026-04-19T01:15:00Z',
    content: { type: 'text', text: '#送迎\nハイエース\n通常ルート\n会社\nA病院\n100\n150' },
  });
  const f = makeForward({ ok: true, status: 200, attempts: 1 });
  const r = await processInboxRow(raw, ISO_FALLBACK, { db: STANDARD_DB(), forward: f.fn });
  assert.equal(r.terminal, 'invalid');
  if (r.terminal !== 'invalid') return;
  assert.equal(r.code, 'missing_sender_user_id');
});

test('accepts ms-epoch createdTime as the message timestamp', async () => {
  const f = makeForward({ ok: true, status: 200, attempts: 1 });
  const ms = Date.UTC(2026, 3, 19, 1, 15, 0); // 2026-04-19T01:15:00Z
  const raw = JSON.stringify({
    type: 'message',
    source: { userId: 'uuid-driver-1' },
    createdTime: ms,
    content: { type: 'text', text: '#送迎\nハイエース\n通常ルート\n会社\nA病院\n100\n150' },
  });
  const r = await processInboxRow(raw, ISO_FALLBACK, { db: STANDARD_DB(), forward: f.fn });
  assert.equal(r.terminal, 'forwarded');
  if (r.terminal !== 'forwarded') return;
  assert.equal(f.calls[0].日付, '2026/4/19 10:15');
});

test('failed: forward returns non-ok → terminal failed (not invalid)', async () => {
  const f = makeForward({ ok: false, status: 502, attempts: 3, error: 'http_502' });
  const r = await processInboxRow(
    body(`#送迎
ハイエース
通常ルート
会社
A病院
100
150`),
    ISO_FALLBACK,
    { db: STANDARD_DB(), forward: f.fn },
  );
  assert.equal(r.terminal, 'failed');
  if (r.terminal !== 'failed') return;
  assert.equal(r.error, 'http_502');
  assert.equal(r.attempts, 3);
});

test('uses issuedTime from body, not the inbox created_at fallback', async () => {
  const f = makeForward({ ok: true, status: 200, attempts: 1 });
  const r = await processInboxRow(
    body(
      `#送迎
ハイエース
通常ルート
会社
A病院
100
150`,
      { issuedTime: '2026-06-01T00:30:00Z' },
    ),
    ISO_FALLBACK,
    { db: STANDARD_DB(), forward: f.fn },
  );
  assert.equal(r.terminal, 'forwarded');
  if (r.terminal !== 'forwarded') return;
  // 2026-06-01T00:30Z → JST 2026-06-01 09:30
  assert.equal(f.calls[0].日付, '2026/6/1 09:30');
  assert.equal(f.calls[0].ExcelPath, '/General/雇用/送迎/2026年送迎記録表/送迎6月自動反映.xlsx');
});
