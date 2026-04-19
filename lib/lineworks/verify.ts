// LINE WORKS webhook signature verification.
// X-WORKS-Signature = base64(HMAC-SHA256(rawBody, botSecret)).
// HMAC must be computed over the EXACT raw request body.

import crypto from 'node:crypto';

export function verifySignature(
  rawBody: string,
  signatureBase64: string,
  secret: string,
): boolean {
  if (!signatureBase64 || !secret) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');
  try {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signatureBase64, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Stable content hash used as the inbox dedup key.
 * LINE WORKS retries send byte-identical bodies on timeout → same hash.
 */
export function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}
