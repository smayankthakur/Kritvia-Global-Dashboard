-- Phase 7.5.1 scale hardening indexes

CREATE INDEX IF NOT EXISTS "security_events_org_id_resolved_at_idx"
  ON "security_events"("org_id", "resolved_at");

CREATE INDEX IF NOT EXISTS "org_members_user_id_status_idx"
  ON "org_members"("user_id", "status");

CREATE INDEX IF NOT EXISTS "activity_logs_org_id_created_at_idx"
  ON "activity_logs"("org_id", "created_at");

CREATE INDEX IF NOT EXISTS "activity_logs_org_id_entity_type_entity_id_created_at_idx"
  ON "activity_logs"("org_id", "entity_type", "entity_id", "created_at");

CREATE INDEX IF NOT EXISTS "leads_org_id_created_at_idx"
  ON "leads"("org_id", "created_at");

CREATE INDEX IF NOT EXISTS "deals_org_id_created_at_idx"
  ON "deals"("org_id", "created_at");

CREATE INDEX IF NOT EXISTS "deals_org_id_updated_at_idx"
  ON "deals"("org_id", "updated_at");

CREATE INDEX IF NOT EXISTS "deals_org_id_is_stale_idx"
  ON "deals"("org_id", "is_stale");

CREATE INDEX IF NOT EXISTS "work_items_org_id_created_at_idx"
  ON "work_items"("org_id", "created_at");

CREATE INDEX IF NOT EXISTS "invoices_org_id_lock_at_idx"
  ON "invoices"("org_id", "lock_at");

CREATE INDEX IF NOT EXISTS "invoices_org_id_created_at_idx"
  ON "invoices"("org_id", "created_at");
