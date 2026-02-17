-- CreateTable
CREATE TABLE "status_subscribers" (
  "id" UUID NOT NULL,
  "org_id" UUID,
  "email" TEXT,
  "webhook_url" TEXT,
  "secret_encrypted" TEXT,
  "is_confirmed" BOOLEAN NOT NULL DEFAULT false,
  "confirmation_token" TEXT NOT NULL,
  "unsub_token" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "status_subscribers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status_subscriptions" (
  "id" UUID NOT NULL,
  "subscriber_id" UUID NOT NULL,
  "component_key" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "status_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status_notification_logs" (
  "id" UUID NOT NULL,
  "subscriber_id" UUID NOT NULL,
  "incident_id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "success" BOOLEAN NOT NULL,
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "status_notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "status_subscribers_confirmation_token_key" ON "status_subscribers"("confirmation_token");
CREATE UNIQUE INDEX "status_subscribers_unsub_token_key" ON "status_subscribers"("unsub_token");
CREATE INDEX "status_subscribers_org_id_idx" ON "status_subscribers"("org_id");
CREATE INDEX "status_subscribers_email_idx" ON "status_subscribers"("email");
CREATE INDEX "status_subscribers_webhook_url_idx" ON "status_subscribers"("webhook_url");
CREATE INDEX "status_subscribers_confirmation_token_idx" ON "status_subscribers"("confirmation_token");
CREATE INDEX "status_subscribers_unsub_token_idx" ON "status_subscribers"("unsub_token");

CREATE UNIQUE INDEX "status_subscriptions_subscriber_id_component_key_key" ON "status_subscriptions"("subscriber_id", "component_key");
CREATE INDEX "status_subscriptions_component_key_idx" ON "status_subscriptions"("component_key");

CREATE INDEX "status_notification_logs_subscriber_id_created_at_idx" ON "status_notification_logs"("subscriber_id", "created_at");
CREATE INDEX "status_notification_logs_incident_id_created_at_idx" ON "status_notification_logs"("incident_id", "created_at");

-- AddForeignKey
ALTER TABLE "status_subscribers" ADD CONSTRAINT "status_subscribers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "status_subscriptions" ADD CONSTRAINT "status_subscriptions_subscriber_id_fkey" FOREIGN KEY ("subscriber_id") REFERENCES "status_subscribers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "status_notification_logs" ADD CONSTRAINT "status_notification_logs_subscriber_id_fkey" FOREIGN KEY ("subscriber_id") REFERENCES "status_subscribers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "status_notification_logs" ADD CONSTRAINT "status_notification_logs_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
