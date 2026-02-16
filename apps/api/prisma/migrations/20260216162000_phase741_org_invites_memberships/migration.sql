-- CreateTable
CREATE TABLE "org_members" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "user_id" UUID,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "joined_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_invite_tokens" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by_user_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_invite_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_members_org_id_email_key" ON "org_members"("org_id", "email");

-- CreateIndex
CREATE INDEX "org_members_org_id_status_idx" ON "org_members"("org_id", "status");

-- CreateIndex
CREATE INDEX "org_members_user_id_idx" ON "org_members"("user_id");

-- CreateIndex
CREATE INDEX "org_invite_tokens_org_id_email_idx" ON "org_invite_tokens"("org_id", "email");

-- CreateIndex
CREATE INDEX "org_invite_tokens_expires_at_idx" ON "org_invite_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "org_invite_tokens_used_at_idx" ON "org_invite_tokens"("used_at");

-- AddForeignKey
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_invite_tokens" ADD CONSTRAINT "org_invite_tokens_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_invite_tokens" ADD CONSTRAINT "org_invite_tokens_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill org_members for existing users
INSERT INTO "org_members" ("id", "org_id", "user_id", "email", "role", "status", "joined_at", "created_at")
SELECT u."id", u."org_id", u."id", lower(u."email"), u."role", 'ACTIVE', u."created_at", NOW()
FROM "users" u
ON CONFLICT ("org_id", "email") DO NOTHING;
