-- AlterTable
ALTER TABLE "marketplace_apps"
ADD COLUMN "oauth_provider" TEXT;

-- AlterTable
ALTER TABLE "org_app_installs"
ADD COLUMN "oauth_provider" TEXT,
ADD COLUMN "oauth_access_token_encrypted" TEXT,
ADD COLUMN "oauth_refresh_token_encrypted" TEXT,
ADD COLUMN "oauth_expires_at" TIMESTAMP(3),
ADD COLUMN "oauth_scope" TEXT,
ADD COLUMN "oauth_account_id" TEXT;
