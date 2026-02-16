-- AlterTable
ALTER TABLE "org_app_installs"
ADD COLUMN "secret_encrypted" TEXT;

-- CreateTable
CREATE TABLE "app_command_logs" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "app_install_id" UUID NOT NULL,
    "command" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "status_code" INTEGER NOT NULL,
    "error" TEXT,
    "request_hash" TEXT NOT NULL,
    "response_snippet" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_command_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_command_logs_org_id_app_install_id_idempotency_key_key"
ON "app_command_logs"("org_id", "app_install_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "app_command_logs_org_id_created_at_idx"
ON "app_command_logs"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "app_command_logs_app_install_id_created_at_idx"
ON "app_command_logs"("app_install_id", "created_at");

-- AddForeignKey
ALTER TABLE "app_command_logs"
ADD CONSTRAINT "app_command_logs_org_id_fkey"
FOREIGN KEY ("org_id") REFERENCES "orgs"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_command_logs"
ADD CONSTRAINT "app_command_logs_app_install_id_fkey"
FOREIGN KEY ("app_install_id") REFERENCES "org_app_installs"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
