-- CreateTable
CREATE TABLE "alert_channels" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "min_severity" TEXT NOT NULL DEFAULT 'HIGH',
    "config_encrypted" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_deliveries" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "alert_event_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "success" BOOLEAN NOT NULL,
    "status_code" INTEGER,
    "error" TEXT,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_channels_org_id_type_idx" ON "alert_channels"("org_id", "type");

-- CreateIndex
CREATE INDEX "alert_channels_org_id_is_enabled_idx" ON "alert_channels"("org_id", "is_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "alert_deliveries_alert_event_id_channel_id_key" ON "alert_deliveries"("alert_event_id", "channel_id");

-- CreateIndex
CREATE INDEX "alert_deliveries_org_id_created_at_idx" ON "alert_deliveries"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "alert_deliveries_alert_event_id_created_at_idx" ON "alert_deliveries"("alert_event_id", "created_at");

-- CreateIndex
CREATE INDEX "alert_deliveries_channel_id_created_at_idx" ON "alert_deliveries"("channel_id", "created_at");

-- AddForeignKey
ALTER TABLE "alert_channels" ADD CONSTRAINT "alert_channels_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "alert_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
