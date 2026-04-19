// Shared UUID validator used by both the drivers admin API (server SSOT)
// and the admin UI form (client pre-check). Keeping the regex in one place
// guarantees the two sides agree on what counts as a valid UUID, while the
// server remains authoritative.

// 8-4-4-4-12 hex, case-insensitive. Not strict about version/variant bits —
// LINE WORKS source.userId is a UUIDv4 in practice but keeping the check
// lenient avoids false rejections on edge cases.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Error message used by the server for both POST and PATCH invalid UUID. */
export const UUID_INVALID_MESSAGE = 'lineworks_user_id must be a valid UUID or null';

/** Error message used by the admin UI (short, form-level). */
export const UUID_INVALID_UI_MESSAGE = 'UUID形式で入力してください';
