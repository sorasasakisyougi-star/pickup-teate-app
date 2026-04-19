-- Phase 2d Step 0: drivers.lineworks_user_id
-- Adds the LINE WORKS webhook source.userId column so Phase 2c's process
-- pipeline can resolve drivers from the webhook envelope (which does not
-- carry a display name).

-- Run order:
--   1. Execute against the Supabase project (SQL editor).
--   2. Populate lineworks_user_id for every active driver before enabling
--      the real Bot webhook.
--   3. Any driver with a NULL lineworks_user_id will receive the reply
--      "LINE WORKS ユーザーID未登録です" when they post a #送迎 message.

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS lineworks_user_id TEXT;

-- Unique when present — one driver per LW user. Does not block rows where
-- lineworks_user_id is still NULL (the pre-provisioning state).
CREATE UNIQUE INDEX IF NOT EXISTS unique_drivers_lineworks_user_id
  ON drivers (lineworks_user_id)
  WHERE lineworks_user_id IS NOT NULL;

COMMENT ON COLUMN drivers.lineworks_user_id IS
  'LINE WORKS webhook source.userId (UUID). Phase 2c pipeline resolves '
  'drivers by this field rather than by display name.';
