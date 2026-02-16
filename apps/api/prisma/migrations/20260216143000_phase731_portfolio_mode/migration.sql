-- Add portfolio entity type to audit enum
ALTER TYPE "ActivityEntityType" ADD VALUE IF NOT EXISTS 'PORTFOLIO';

-- CreateTable
CREATE TABLE "org_groups" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_group_members" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'OWNER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_group_orgs" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_group_orgs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "org_groups_owner_user_id_idx" ON "org_groups"("owner_user_id");

-- CreateIndex
CREATE INDEX "org_group_members_user_id_idx" ON "org_group_members"("user_id");

-- CreateIndex
CREATE INDEX "org_group_members_group_id_idx" ON "org_group_members"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_group_members_group_id_user_id_key" ON "org_group_members"("group_id", "user_id");

-- CreateIndex
CREATE INDEX "org_group_orgs_group_id_idx" ON "org_group_orgs"("group_id");

-- CreateIndex
CREATE INDEX "org_group_orgs_org_id_idx" ON "org_group_orgs"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_group_orgs_group_id_org_id_key" ON "org_group_orgs"("group_id", "org_id");

-- AddForeignKey
ALTER TABLE "org_groups" ADD CONSTRAINT "org_groups_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_group_members" ADD CONSTRAINT "org_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "org_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_group_members" ADD CONSTRAINT "org_group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_group_orgs" ADD CONSTRAINT "org_group_orgs_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "org_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_group_orgs" ADD CONSTRAINT "org_group_orgs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

