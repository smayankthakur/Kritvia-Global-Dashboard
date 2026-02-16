-- AlterEnum
ALTER TYPE "ActivityEntityType" ADD VALUE IF NOT EXISTS 'APP';

-- AlterTable
ALTER TABLE "plans" ADD COLUMN "developer_platform_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "marketplace_apps" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "developer_name" TEXT,
    "website_url" TEXT,
    "icon_url" TEXT,
    "category" TEXT,
    "scopes" JSONB,
    "webhook_events" JSONB,
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketplace_apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_app_installs" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "app_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'INSTALLED',
    "installed_by_user_id" UUID,
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabled_at" TIMESTAMP(3),
    "uninstalled_at" TIMESTAMP(3),
    "config_encrypted" TEXT,
    "config_version" INTEGER NOT NULL DEFAULT 1,
    "secret_hash" TEXT,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "org_app_installs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_apps_key_key" ON "marketplace_apps"("key");

-- CreateIndex
CREATE INDEX "marketplace_apps_is_published_idx" ON "marketplace_apps"("is_published");

-- CreateIndex
CREATE INDEX "marketplace_apps_category_idx" ON "marketplace_apps"("category");

-- CreateIndex
CREATE UNIQUE INDEX "org_app_installs_org_id_app_id_key" ON "org_app_installs"("org_id", "app_id");

-- CreateIndex
CREATE INDEX "org_app_installs_org_id_status_idx" ON "org_app_installs"("org_id", "status");

-- CreateIndex
CREATE INDEX "org_app_installs_app_id_idx" ON "org_app_installs"("app_id");

-- AddForeignKey
ALTER TABLE "org_app_installs" ADD CONSTRAINT "org_app_installs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_app_installs" ADD CONSTRAINT "org_app_installs_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "marketplace_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_app_installs" ADD CONSTRAINT "org_app_installs_installed_by_user_id_fkey" FOREIGN KEY ("installed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
