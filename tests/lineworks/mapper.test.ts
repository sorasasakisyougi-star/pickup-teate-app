import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMessageBody } from '../../lib/lineworks/parse';
import {
  buildV1Payload,
  buildExcelPathForJst,
  formatDateTimeForExcel,
} from '../../lib/lineworks/mapper';

function parse(body: string) {
  const r = parseMessageBody(body);
  if (!r.ok) throw new Error(`fixture parse failed: ${r.code}`);
  return r.data;
}

// 2026-04-19T01:15:00Z == 2026-04-19T10:15+09:00 (JST)
const TS = new Date('2026-04-19T01:15:00Z');

test('buildV1Payload — spec 通常ルート example', () => {
  const parsed = parse(`#送迎
ハイエース
通常ルート
会社
A病院
B老人ホーム
215159
215185`);
  const p = buildV1Payload(parsed, {
    driverName: '山田太郎',
    messageTimestamp: TS,
    fareYen: 1400,
  });
  assert.equal(p.日付, '2026/4/19 10:15');
  assert.equal(p.ExcelPath, '/General/雇用/送迎/2026年送迎記録表/送迎4月自動反映.xlsx');
  assert.equal(p.運転者, '山田太郎');
  assert.equal(p.車両, 'ハイエース');
  assert.equal(p.バス, '通常ルート');
  assert.equal(p.出発地, '会社');
  assert.equal(p.到着１, 'A病院');
  assert.equal(p.到着２, 'B老人ホーム');
  assert.equal(p.到着３, '');
  assert.equal(p.到着８, '');
  assert.equal(p['金額（円）'], 1400);
  assert.equal(p['距離（始）'], 215159);
  assert.equal(p['距離（終）'], 215185);
  assert.equal(p['総走行距離（km）'], 26);
  assert.equal(p['距離（始）〜到着１'], '');
  assert.equal(p.備考, '');
  assert.equal(p.出発写真URL, '');
  assert.equal(p.到着写真URL到着１, '');
});

test('buildV1Payload — バス sets バス="バス" and preserves 4行目 as 出発地', () => {
  const parsed = parse(`#送迎
ハイエース
バス
-
A病院
215159
215185`);
  const p = buildV1Payload(parsed, {
    driverName: '山田太郎',
    messageTimestamp: TS,
    fareYen: 2000,
  });
  assert.equal(p.バス, 'バス');
  assert.equal(p.出発地, '-');
  assert.equal(p.到着１, 'A病院');
  assert.equal(p['金額（円）'], 2000);
});

test('buildV1Payload — 備考 passes through', () => {
  const parsed = parse(`#送迎
ハイエース
通常ルート
会社
A病院
100
120
備考:雨で渋滞`);
  const p = buildV1Payload(parsed, {
    driverName: 'd',
    messageTimestamp: TS,
    fareYen: 500,
  });
  assert.equal(p.備考, '雨で渋滞');
});

test('buildV1Payload — 写真 URLs pad to 8 slots', () => {
  const parsed = parse(`#送迎
ハイエース
通常ルート
会社
A病院
B
100
150`);
  const p = buildV1Payload(parsed, {
    driverName: 'd',
    messageTimestamp: TS,
    fareYen: 800,
    departPhotoUrl: 'https://cdn.example.com/d.jpg',
    arrivalPhotoUrls: ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'],
  });
  assert.equal(p.出発写真URL, 'https://cdn.example.com/d.jpg');
  assert.equal(p.到着写真URL到着１, 'https://cdn.example.com/a.jpg');
  assert.equal(p.到着写真URL到着２, 'https://cdn.example.com/b.jpg');
  assert.equal(p.到着写真URL到着３, '');
  assert.equal(p.到着写真URL到着８, '');
});

test('buildV1Payload — 総走行距離 = odoEnd - odoStart, clamped to 0', () => {
  const parsed = parse(`#送迎
ハイエース
通常ルート
会社
A
100
90`);
  const p = buildV1Payload(parsed, {
    driverName: 'd',
    messageTimestamp: TS,
    fareYen: 0,
  });
  assert.equal(p['総走行距離（km）'], 0);
});

test('buildV1Payload — preserves all 8 arrivals', () => {
  const parsed = parse(`#送迎
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
100
200`);
  const p = buildV1Payload(parsed, {
    driverName: 'd',
    messageTimestamp: TS,
    fareYen: 0,
  });
  assert.equal(p.到着１, 'A');
  assert.equal(p.到着２, 'B');
  assert.equal(p.到着３, 'C');
  assert.equal(p.到着４, 'D');
  assert.equal(p.到着５, 'E');
  assert.equal(p.到着６, 'F');
  assert.equal(p.到着７, 'G');
  assert.equal(p.到着８, 'H');
});

test('buildExcelPathForJst — uses message month in JST', () => {
  // 2026-03-31T16:00:00Z → 2026-04-01T01:00+09:00 (next day / month in JST)
  const path = buildExcelPathForJst(new Date('2026-03-31T16:00:00Z'));
  assert.equal(path, '/General/雇用/送迎/2026年送迎記録表/送迎4月自動反映.xlsx');
});

test('formatDateTimeForExcel — JST conversion', () => {
  assert.equal(formatDateTimeForExcel(new Date('2026-04-19T01:15:00Z')), '2026/4/19 10:15');
});
