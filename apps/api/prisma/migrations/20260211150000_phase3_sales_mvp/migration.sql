-- Alter ActivityEntityType for sales entities
ALTER TYPE "ActivityEntityType" ADD VALUE IF NOT EXISTS 'COMPANY';
ALTER TYPE "ActivityEntityType" ADD VALUE IF NOT EXISTS 'CONTACT';
ALTER TYPE "ActivityEntityType" ADD VALUE IF NOT EXISTS 'LEAD';
ALTER TYPE "ActivityEntityType" ADD VALUE IF NOT EXISTS 'DEAL';

-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM ('NEW', 'QUALIFIED', 'DISQUALIFIED');

-- CreateEnum
CREATE TYPE "DealStage" AS ENUM ('OPEN', 'WON', 'LOST');

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "industry" TEXT,
    "website" TEXT,
    "owner_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "title" TEXT,
    "owner_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "stage" "LeadStage" NOT NULL DEFAULT 'NEW',
    "source" TEXT,
    "notes" TEXT,
    "company_id" UUID,
    "contact_id" UUID,
    "owner_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deals" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "stage" "DealStage" NOT NULL DEFAULT 'OPEN',
    "value_amount" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "expected_close_date" TIMESTAMP(3),
    "won_at" TIMESTAMP(3),
    "company_id" UUID NOT NULL,
    "owner_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "companies_org_id_idx" ON "companies"("org_id");
CREATE UNIQUE INDEX "companies_org_id_name_key" ON "companies"("org_id", "name");

CREATE INDEX "contacts_org_id_idx" ON "contacts"("org_id");
CREATE INDEX "contacts_company_id_idx" ON "contacts"("company_id");

CREATE INDEX "leads_org_id_idx" ON "leads"("org_id");
CREATE INDEX "leads_org_id_stage_idx" ON "leads"("org_id", "stage");

CREATE INDEX "deals_org_id_idx" ON "deals"("org_id");
CREATE INDEX "deals_org_id_stage_idx" ON "deals"("org_id", "stage");
CREATE INDEX "deals_company_id_idx" ON "deals"("company_id");

-- Foreign Keys
ALTER TABLE "companies" ADD CONSTRAINT "companies_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "companies" ADD CONSTRAINT "companies_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "contacts" ADD CONSTRAINT "contacts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "leads" ADD CONSTRAINT "leads_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leads" ADD CONSTRAINT "leads_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "leads" ADD CONSTRAINT "leads_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "leads" ADD CONSTRAINT "leads_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "deals" ADD CONSTRAINT "deals_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deals" ADD CONSTRAINT "deals_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deals" ADD CONSTRAINT "deals_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
