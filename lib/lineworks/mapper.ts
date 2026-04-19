// Phase 2c mapper: ParsedMessage → Power Automate payload shape.
// Pure function — Supabase lookups live in enrich.ts and produce the fareYen
// that this mapper receives as input.
//
// SSOT field names mirror pages/api/powerautomate.ts#PowerAutomatePayload.
// We cannot import that type because it is not exported; we redeclare the
// matching shape here (widened to allow 備考 to carry free text).

import type { ParsedMessage } from './parse';

export type V1Payload = {
  ExcelPath: string;
  日付: string;
  運転者: string;
  車両: string;
  出発地: string;
  到着１: string;
  到着２: string;
  到着３: string;
  到着４: string;
  到着５: string;
  到着６: string;
  到着７: string;
  到着８: string;
  バス: string;
  '金額（円）': number;
  '距離（始）': number | '';
  '距離（終）': number | '';
  '距離（始）〜到着１': number | '';
  '距離（到着１〜到着２）': number | '';
  '距離（到着２〜到着３）': number | '';
  '距離（到着３〜到着４）': number | '';
  '距離（到着４〜到着５）': number | '';
  '距離（到着５〜到着６）': number | '';
  '距離（到着６〜到着７）': number | '';
  '距離（到着７〜到着８）': number | '';
  '総走行距離（km）': number | '';
  '想定距離（km）': '';
  '超過距離（km）': '';
  距離警告: '';
  区間警告詳細: '';
  備考: string;
  出発写真URL: string;
  到着写真URL到着１: string;
  到着写真URL到着２: string;
  到着写真URL到着３: string;
  到着写真URL到着４: string;
  到着写真URL到着５: string;
  到着写真URL到着６: string;
  到着写真URL到着７: string;
  到着写真URL到着８: string;
};

export type MapperContext = {
  driverName: string;
  messageTimestamp: Date;
  fareYen: number;
  departPhotoUrl?: string;
  arrivalPhotoUrls?: ReadonlyArray<string>;
};

// --- JST date helpers (duplicated from pages/api/powerautomate.ts:628-659) -

function getJstParts(date: Date): {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
} {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const pick = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === t)?.value ?? '';
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour'),
    minute: pick('minute'),
  };
}

export function formatDateTimeForExcel(date: Date): string {
  const { year, month, day, hour, minute } = getJstParts(date);
  return `${Number(year)}/${Number(month)}/${Number(day)} ${hour}:${minute}`;
}

export function buildExcelPathForJst(date: Date): string {
  const { year, month } = getJstParts(date);
  return `/General/雇用/送迎/${year}年送迎記録表/送迎${Number(month)}月自動反映.xlsx`;
}

// --- mapper ----------------------------------------------------------------

function padSlots(values: ReadonlyArray<string> | undefined): [
  string, string, string, string, string, string, string, string,
] {
  const slots: string[] = ['', '', '', '', '', '', '', ''];
  if (values) for (let i = 0; i < Math.min(values.length, 8); i++) slots[i] = values[i];
  return slots as [string, string, string, string, string, string, string, string];
}

export function buildV1Payload(parsed: ParsedMessage, ctx: MapperContext): V1Payload {
  const [a1, a2, a3, a4, a5, a6, a7, a8] = padSlots(parsed.arrivals);
  const [p1, p2, p3, p4, p5, p6, p7, p8] = padSlots(ctx.arrivalPhotoUrls);

  const totalDistance =
    Number.isFinite(parsed.odoEnd) && Number.isFinite(parsed.odoStart)
      ? Math.max(0, parsed.odoEnd - parsed.odoStart)
      : '';

  return {
    ExcelPath: buildExcelPathForJst(ctx.messageTimestamp),
    日付: formatDateTimeForExcel(ctx.messageTimestamp),
    運転者: ctx.driverName,
    車両: parsed.vehicle,
    出発地: parsed.from,
    到着１: a1,
    到着２: a2,
    到着３: a3,
    到着４: a4,
    到着５: a5,
    到着６: a6,
    到着７: a7,
    到着８: a8,
    バス: parsed.isBus ? 'バス' : '通常ルート',
    '金額（円）': ctx.fareYen,
    '距離（始）': parsed.odoStart,
    '距離（終）': parsed.odoEnd,
    // Per-segment distances unavailable from LW body (no per-arrival odometer).
    // Leave blank — total is the real odometer delta below.
    '距離（始）〜到着１': '',
    '距離（到着１〜到着２）': '',
    '距離（到着２〜到着３）': '',
    '距離（到着３〜到着４）': '',
    '距離（到着４〜到着５）': '',
    '距離（到着５〜到着６）': '',
    '距離（到着６〜到着７）': '',
    '距離（到着７〜到着８）': '',
    '総走行距離（km）': totalDistance,
    '想定距離（km）': '',
    '超過距離（km）': '',
    距離警告: '',
    区間警告詳細: '',
    備考: parsed.note ?? '',
    出発写真URL: ctx.departPhotoUrl ?? '',
    到着写真URL到着１: p1,
    到着写真URL到着２: p2,
    到着写真URL到着３: p3,
    到着写真URL到着４: p4,
    到着写真URL到着５: p5,
    到着写真URL到着６: p6,
    到着写真URL到着７: p7,
    到着写真URL到着８: p8,
  };
}
