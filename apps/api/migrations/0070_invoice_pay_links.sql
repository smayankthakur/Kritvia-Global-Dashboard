-- =============================================================================
-- 0070 Every Razorpay link an invoice has had (pre-launch test report, T5).
-- An invoice keeps one current link (pay_link_id), but a link made earlier (the balance changed, or two
-- customers' taps raced) stays payable at Razorpay. The webhook now matches any link the invoice was
-- given, so money paid on an older link is still recorded against it.
-- =============================================================================
ALTER TABLE invoices
  ADD COLUMN pay_link_ids text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(pay_link_ids) <= 50);

UPDATE invoices SET pay_link_ids = ARRAY[pay_link_id] WHERE pay_link_id IS NOT NULL;

CREATE INDEX invoices_pay_link_ids_idx ON invoices USING gin (pay_link_ids);
