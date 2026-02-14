-- AlterTable
ALTER TABLE "invoices"
ADD COLUMN "sent_at" TIMESTAMP(3),
ADD COLUMN "lock_at" TIMESTAMP(3);
