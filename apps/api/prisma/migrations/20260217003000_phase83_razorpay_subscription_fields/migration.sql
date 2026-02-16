-- Phase 8.3: rename subscription provider fields from Stripe to Razorpay

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'subscriptions' AND column_name = 'stripe_customer_id'
  ) THEN
    ALTER TABLE "subscriptions" RENAME COLUMN "stripe_customer_id" TO "razorpay_customer_id";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'subscriptions' AND column_name = 'stripe_subscription_id'
  ) THEN
    ALTER TABLE "subscriptions" RENAME COLUMN "stripe_subscription_id" TO "razorpay_subscription_id";
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "subscriptions_razorpay_subscription_id_idx"
  ON "subscriptions" ("razorpay_subscription_id");
