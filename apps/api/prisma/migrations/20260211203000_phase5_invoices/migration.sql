-- Alter ActivityEntityType for invoices
ALTER TYPE "ActivityEntityType" ADD VALUE IF NOT EXISTS 'INVOICE';

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'PAID', 'OVERDUE');

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "invoice_number" TEXT,
    "company_id" UUID NOT NULL,
    "deal_id" UUID,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "issue_date" DATE NOT NULL DEFAULT CURRENT_DATE,
    "due_date" DATE NOT NULL,
    "locked_at" TIMESTAMP(3),
    "locked_by_user_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "invoices_org_id_status_idx" ON "invoices"("org_id", "status");
CREATE INDEX "invoices_org_id_due_date_idx" ON "invoices"("org_id", "due_date");
CREATE INDEX "invoices_org_id_company_id_idx" ON "invoices"("org_id", "company_id");

-- Foreign Keys
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_locked_by_user_id_fkey" FOREIGN KEY ("locked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
