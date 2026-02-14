-- AlterTable
ALTER TABLE "nudges"
ADD COLUMN "action_type" TEXT,
ADD COLUMN "action_payload" JSONB,
ADD COLUMN "executed_at" TIMESTAMP(3),
ADD COLUMN "undo_expires_at" TIMESTAMP(3),
ADD COLUMN "undo_data" JSONB;
