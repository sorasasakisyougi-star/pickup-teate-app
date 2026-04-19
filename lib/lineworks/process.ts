// Phase 2c pipeline: take a raw LINE WORKS webhook body and drive it through
// parse → enrich → map → forward. Pure-ish: all side effects (DB, HTTP) come
// through injected dependencies, so we can exercise every code path in unit
// tests without Supabase or a real fetch.

import { parseMessageBody, type ParseErrorCode } from './parse';
import {
  resolveDriverByName,
  resolveRouteLocations,
  computeFareYen,
  resolveSegmentDistances,
  type EnrichDbClient,
  type NamedRow,
} from './enrich';
import { buildV1Payload, type V1Payload } from './mapper';
import type { ForwardResult } from './forward';

export type ProcessOutcome =
  | {
      terminal: 'forwarded';
      payload: V1Payload;
      receiptId: string | null;
      attempts: number;
    }
  | {
      terminal: 'invalid';
      code: InvalidCode;
      userMessage: string;
    }
  | {
      terminal: 'failed';
      error: string;
      attempts: number;
    };

export type InvalidCode =
  | 'not_a_soutei_message'
  | ParseErrorCode
  | 'driver_not_registered'
  | 'location_not_registered'
  | 'fare_not_registered'
  | 'distance_not_registered'
  | 'missing_message_body'
  | 'missing_sender_name'
  | 'missing_message_timestamp';

export type ProcessDeps = {
  db: EnrichDbClient;
  forward: (payload: V1Payload) => Promise<ForwardResult>;
};

type JsonObj = Record<string, unknown>;

function asObj(v: unknown): JsonObj | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObj) : null;
}

function pickStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function extractText(body: JsonObj): string | null {
  const content = asObj(body.content);
  return content ? pickStr(content.text) : null;
}

function extractSenderName(body: JsonObj): string | null {
  const source = asObj(body.source);
  const content = asObj(body.content);
  return (
    (source && pickStr(source.userName)) ||
    (source && pickStr(source.name)) ||
    (source && pickStr(source.displayName)) ||
    pickStr(body.userName) ||
    pickStr(body.senderName) ||
    (content && pickStr(content.userName)) ||
    null
  );
}

function extractIssuedTime(body: JsonObj, fallbackIso: string): Date | null {
  const raw = pickStr(body.issuedTime) ?? pickStr(body.createdTime) ?? fallbackIso;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

const invalidMessages: Record<InvalidCode, string> = {
  not_a_soutei_message: '',
  no_response: '',
  invalid_format: '入力形式が違います',
  invalid_kubun: '区分は「通常ルート」か「バス」です',
  too_many_arrivals: '到着地は最大8件です',
  missing_arrivals: '到着地がありません',
  missing_odo: 'ODO始/ODO終がありません',
  driver_not_registered: '運転者名が未登録です',
  location_not_registered: '場所名が未登録です',
  fare_not_registered: '料金マスタが未登録です',
  distance_not_registered: '区間距離マスタが未登録です',
  missing_message_body: '入力形式が違います',
  missing_sender_name: '送信者名が取得できません',
  missing_message_timestamp: '送信時刻が取得できません',
};

function invalid(code: InvalidCode, overrideMessage?: string): ProcessOutcome {
  return {
    terminal: 'invalid',
    code,
    userMessage: overrideMessage ?? invalidMessages[code],
  };
}

export async function processInboxRow(
  rawBody: string,
  createdAtIso: string,
  deps: ProcessDeps,
): Promise<ProcessOutcome> {
  let body: JsonObj | null;
  try {
    const parsedJson = JSON.parse(rawBody);
    body = asObj(parsedJson);
  } catch {
    return invalid('missing_message_body');
  }
  if (!body) return invalid('missing_message_body');

  const text = extractText(body);
  if (!text) return invalid('missing_message_body');

  const parsed = parseMessageBody(text);
  if (!parsed.ok) {
    if (parsed.code === 'no_response') return invalid('not_a_soutei_message');
    return invalid(parsed.code, parsed.userMessage);
  }

  const senderName = extractSenderName(body);
  if (!senderName) return invalid('missing_sender_name');

  const messageTimestamp = extractIssuedTime(body, createdAtIso);
  if (!messageTimestamp) return invalid('missing_message_timestamp');

  let driver;
  try {
    driver = await resolveDriverByName(deps.db, senderName);
  } catch (e) {
    return {
      terminal: 'failed',
      error: e instanceof Error ? e.message : 'drivers_query_failed',
      attempts: 0,
    };
  }
  if (!driver) return invalid('driver_not_registered');

  let locations;
  try {
    locations = await resolveRouteLocations(deps.db, parsed.data.from, parsed.data.arrivals);
  } catch (e) {
    return {
      terminal: 'failed',
      error: e instanceof Error ? e.message : 'locations_query_failed',
      attempts: 0,
    };
  }
  // 通常ルート: from must resolve; all arrivals must resolve.
  // バス: from may be "-" (null is OK); arrivals must still resolve.
  if (!parsed.data.isBus && !locations.from) {
    return invalid('location_not_registered');
  }
  const resolvedArrivals: NamedRow[] = locations.arrivals.filter(
    (a): a is NamedRow => a !== null,
  );
  if (resolvedArrivals.length !== locations.arrivals.length) {
    return invalid('location_not_registered');
  }
  const fromId = locations.from?.id ?? null;
  const arrivalIds = resolvedArrivals.map((a) => a.id);

  let fareYen: number | null;
  try {
    fareYen = await computeFareYen(deps.db, fromId, arrivalIds, parsed.data.isBus);
  } catch (e) {
    return {
      terminal: 'failed',
      error: e instanceof Error ? e.message : 'fares_query_failed',
      attempts: 0,
    };
  }
  if (fareYen == null) return invalid('fare_not_registered');

  // 通常ルート: require a route_distances row for every leg. Missing → invalid.
  // バス: distances aren't contractually defined (from may be "-") → skip lookup.
  let segmentDistances: number[] | undefined;
  if (!parsed.data.isBus && fromId != null) {
    try {
      const segs = await resolveSegmentDistances(deps.db, fromId, arrivalIds);
      if (segs == null) return invalid('distance_not_registered');
      segmentDistances = segs;
    } catch (e) {
      return {
        terminal: 'failed',
        error: e instanceof Error ? e.message : 'route_distances_query_failed',
        attempts: 0,
      };
    }
  }

  const payload = buildV1Payload(parsed.data, {
    driverName: driver.name,
    messageTimestamp,
    fareYen,
    segmentDistances,
  });

  const result = await deps.forward(payload);
  if (result.ok) {
    // Power Automate returns an HTTP status; the flow-run-id (if any) lives in
    // the response body which we do not read. Record null rather than a
    // misleading "200" string that isn't a real receipt.
    return {
      terminal: 'forwarded',
      payload,
      receiptId: null,
      attempts: result.attempts,
    };
  }
  return {
    terminal: 'failed',
    error: result.error,
    attempts: result.attempts,
  };
}
