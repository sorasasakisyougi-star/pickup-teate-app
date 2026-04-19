// Phase 2c forwarder: POST V1Payload to POWER_AUTOMATE_WEBHOOK_URL.
// Same transport Power Automate already trusts in the pickup-order path.
// Failures are retried up to `maxAttempts` with exponential backoff; the
// inbox row is marked `forwarded` only on 2xx.

import type { V1Payload } from './mapper';

export type ForwardResult =
  | { ok: true; status: number; attempts: number }
  | { ok: false; status: number | null; attempts: number; error: string };

export type ForwardOptions = {
  webhookUrl?: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 200;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function forwardToPowerAutomate(
  payload: V1Payload,
  options: ForwardOptions = {},
): Promise<ForwardResult> {
  const webhookUrl = options.webhookUrl ?? process.env.POWER_AUTOMATE_WEBHOOK_URL ?? '';
  if (!webhookUrl) {
    return { ok: false, status: null, attempts: 0, error: 'webhook_url_missing' };
  }

  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelay = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const doFetch = options.fetchImpl ?? fetch;
  const doSleep = options.sleep ?? defaultSleep;

  let lastStatus: number | null = null;
  let lastError = 'send_failed';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await doFetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      lastStatus = res.status;
      if (res.ok) {
        return { ok: true, status: res.status, attempts: attempt };
      }
      lastError = `http_${res.status}`;
    } catch (e) {
      lastStatus = null;
      lastError = e instanceof Error ? e.message : 'network_error';
    }

    if (attempt < maxAttempts) {
      await doSleep(baseDelay * 2 ** (attempt - 1));
    }
  }

  return { ok: false, status: lastStatus, attempts: maxAttempts, error: lastError };
}
