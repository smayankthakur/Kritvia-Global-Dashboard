-- kritvia: no-transaction
-- Validates the constraints 0078 added NOT VALID, outside a transaction, so the scan doesn't hold the
-- lock taken to add them (round 3, B14).
ALTER TABLE proposals VALIDATE CONSTRAINT proposals_lead_fk;
ALTER TABLE outbox_messages VALIDATE CONSTRAINT outbox_messages_approval_id_fkey;
