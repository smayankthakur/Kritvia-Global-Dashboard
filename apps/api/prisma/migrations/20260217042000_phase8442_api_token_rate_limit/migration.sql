-- Phase 8.4.4.2: API token rate limiting fields

ALTER TABLE "api_tokens"
ADD COLUMN IF NOT EXISTS "rate_limit_per_hour" INTEGER NOT NULL DEFAULT 1000,
ADD COLUMN IF NOT EXISTS "requests_this_hour" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "hour_window_start" TIMESTAMP(3);
