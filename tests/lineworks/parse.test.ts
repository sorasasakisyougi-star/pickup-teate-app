import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMessageBody } from '../../lib/lineworks/parse';

test('parses the spec 通常ルート example', () => {
  const body = `#送迎
ハイエース
通常ルート
会社
A病院
B老人ホーム
215159
215185`;
  const r = parseMessageBody(body);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.data.vehicle, 'ハイエース');
  assert.equal(r.data.kubun, '通常ルート');
  assert.equal(r.data.isBus, false);
  assert.equal(r.data.from, '会社');
  assert.deepEqual(r.data.arrivals, ['A病院', 'B老人ホーム']);
  assert.equal(r.data.odoStart, 215159);
  assert.equal(r.data.odoEnd, 215185);
  assert.equal(r.data.note, null);
});

test('parses the spec バス example with - as from', () => {
  const body = `#送迎
ハイエース
バス
-
A病院
215159
215185`;
  const r = parseMessageBody(body);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.data.kubun, 'バス');
  assert.equal(r.data.isBus, true);
  assert.equal(r.data.from, '-');
  assert.deepEqual(r.data.arrivals, ['A病院']);
});

test('parses optional 備考 trailing line', () => {
  const body = `#送迎
ハイエース
通常ルート
会社
A病院
215159
215185
備考:雨`;
  const r = parseMessageBody(body);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.data.note, '雨');
});

test('accepts full-width digits and 全角コロン in 備考', () => {
  const body = `#送迎
ハイエース
通常ルート
会社
A病院
２１５１５９
215185.5
備考：雨`;
  const r = parseMessageBody(body);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.data.odoStart, 215159);
  assert.equal(r.data.odoEnd, 215185.5);
  assert.equal(r.data.note, '雨');
});

test('trims whitespace and ignores blank lines', () => {
  const body = `
  #送迎
  ハイエース
   通常ルート
  会社

  A病院
  215159
  215185
`;
  const r = parseMessageBody(body);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.data.vehicle, 'ハイエース');
  assert.equal(r.data.from, '会社');
});

test('returns no_response when first non-empty line is not #送迎', () => {
  const r = parseMessageBody('こんにちは\n何か\n');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'no_response');
  assert.equal(r.userMessage, '');
});

test('returns no_response on empty input', () => {
  const r = parseMessageBody('');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'no_response');
});

test('rejects 区分 that is not 通常ルート/バス', () => {
  const body = `#送迎
ハイエース
特別
会社
A病院
1
2`;
  const r = parseMessageBody(body);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'invalid_kubun');
  assert.equal(r.userMessage, '区分は「通常ルート」か「バス」です');
});

test('rejects when ODO 行が足りない', () => {
  const body = `#送迎
ハイエース
通常ルート
会社
A病院
B老人ホーム`;
  const r = parseMessageBody(body);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'invalid_format');
});

test('rejects when only one ODO line present', () => {
  const body = `#送迎
ハイエース
通常ルート
会社
A病院
B老人ホーム
C施設
215159`;
  const r = parseMessageBody(body);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'missing_odo');
  assert.equal(r.userMessage, 'ODO始/ODO終がありません');
});

test('rejects more than 8 arrivals', () => {
  const body = `#送迎
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
215159
215185`;
  const r = parseMessageBody(body);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'too_many_arrivals');
  assert.equal(r.userMessage, '到着地は最大8件です');
});

test('accepts exactly 8 arrivals', () => {
  const body = `#送迎
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
215159
215185`;
  const r = parseMessageBody(body);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.data.arrivals.length, 8);
});

test('rejects zero arrivals (ODO immediately follows from)', () => {
  const body = `#送迎
ハイエース
通常ルート
会社
215159
215185
備考:x`;
  const r = parseMessageBody(body);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'missing_arrivals');
});

test('rejects unknown trailing line after ODO終', () => {
  const body = `#送迎
ハイエース
通常ルート
会社
A病院
215159
215185
何か`;
  const r = parseMessageBody(body);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'invalid_format');
});

test('does NOT bus-detect when 区分=通常ルート even if from is "-"', () => {
  const body = `#送迎
ハイエース
通常ルート
-
A病院
215159
215185`;
  const r = parseMessageBody(body);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.data.isBus, false);
  assert.equal(r.data.from, '-');
});
