// Phase 2c V1 body contract parser.
//
// Expected body shape:
//   #送迎
//   <vehicle>
//   <区分>                通常ルート | バス
//   <from>                "-" allowed when バス
//   <arrival 1..8>
//   <ODO始 numeric>
//   <ODO終 numeric>
//   備考:<free text>      (optional, last line)
//
// Lines are trimmed and empty lines are ignored.
// Arrivals are lines AFTER line 4 and BEFORE the first numeric-only line.

export type Kubun = '通常ルート' | 'バス';

export type ParsedMessage = {
  vehicle: string;
  kubun: Kubun;
  isBus: boolean;
  from: string;
  arrivals: string[]; // 1..8
  odoStart: number;
  odoEnd: number;
  note: string | null;
};

// Code strings are also what the Bot should say back to the driver on invalid.
export type ParseErrorCode =
  | 'no_response'              // not a #送迎 message → Bot stays silent
  | 'invalid_format'           // generic shape error
  | 'invalid_kubun'            // line 3 not 通常ルート/バス
  | 'too_many_arrivals'        // >8
  | 'missing_arrivals'         // 0
  | 'missing_odo';             // ODO始/ODO終 not present

export type ParseFailure = {
  ok: false;
  code: ParseErrorCode;
  userMessage: string;
};

export type ParseSuccess = {
  ok: true;
  data: ParsedMessage;
};

export type ParseResult = ParseSuccess | ParseFailure;

const MAX_ARRIVALS = 8;
const HEADER_TOKEN = '#送迎';
const VALID_KUBUN: ReadonlyArray<Kubun> = ['通常ルート', 'バス'];

// Accept half-width and full-width digits, optional single decimal point.
const NUMERIC_LINE = /^[0-9０-９]+(?:[.．][0-9０-９]+)?$/;

const userMessages: Record<ParseErrorCode, string> = {
  no_response: '',
  invalid_format: '入力形式が違います',
  invalid_kubun: '区分は「通常ルート」か「バス」です',
  too_many_arrivals: '到着地は最大8件です',
  missing_arrivals: '到着地がありません',
  missing_odo: 'ODO始/ODO終がありません',
};

function fail(code: ParseErrorCode): ParseFailure {
  return { ok: false, code, userMessage: userMessages[code] };
}

function normalizeDigits(s: string): string {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．]/g, '.');
}

function isNumericLine(s: string): boolean {
  return NUMERIC_LINE.test(s);
}

function toNumber(s: string): number {
  return Number(normalizeDigits(s));
}

export function parseMessageBody(raw: string): ParseResult {
  if (typeof raw !== 'string') return fail('invalid_format');

  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0 || lines[0] !== HEADER_TOKEN) {
    return { ok: false, code: 'no_response', userMessage: '' };
  }

  // Minimum viable shape: header + vehicle + kubun + from + ≥1 arrival + 2 ODO = 7 lines.
  if (lines.length < 7) return fail('invalid_format');

  const vehicle = lines[1];
  const kubunRaw = lines[2];
  const from = lines[3];

  if (!VALID_KUBUN.includes(kubunRaw as Kubun)) return fail('invalid_kubun');
  const kubun = kubunRaw as Kubun;
  const isBus = kubun === 'バス';

  if (vehicle.length === 0 || from.length === 0) return fail('invalid_format');

  // Walk lines 5+ collecting arrivals until the first numeric-only line.
  const arrivals: string[] = [];
  let cursor = 4;
  while (cursor < lines.length && !isNumericLine(lines[cursor])) {
    arrivals.push(lines[cursor]);
    cursor++;
    if (arrivals.length > MAX_ARRIVALS) return fail('too_many_arrivals');
  }

  if (arrivals.length === 0) return fail('missing_arrivals');

  if (cursor >= lines.length) return fail('missing_odo');
  if (!isNumericLine(lines[cursor])) return fail('missing_odo');
  const odoStart = toNumber(lines[cursor]);
  cursor++;

  if (cursor >= lines.length || !isNumericLine(lines[cursor])) return fail('missing_odo');
  const odoEnd = toNumber(lines[cursor]);
  cursor++;

  if (!Number.isFinite(odoStart) || !Number.isFinite(odoEnd)) return fail('missing_odo');

  // Optional trailing 備考:<text>.
  let note: string | null = null;
  if (cursor < lines.length) {
    const last = lines[cursor];
    const match = last.match(/^備考[：:](.*)$/);
    if (!match) return fail('invalid_format');
    note = match[1].trim();
    cursor++;
    if (cursor < lines.length) return fail('invalid_format');
  }

  return {
    ok: true,
    data: { vehicle, kubun, isBus, from, arrivals, odoStart, odoEnd, note },
  };
}
