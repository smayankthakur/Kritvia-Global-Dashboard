-- =============================================================================
-- 0053 IndiaMART enquiries come in by themselves.
--
--   connectors.provider 'indiamart'   a business's IndiaMART Lead Manager "Pull API" key (stored
--                                     encrypted in connector_tokens, like every other secret). The
--                                     worker asks IndiaMART for new enquiries every 10 minutes and
--                                     each one starts lead triage, once:
--                                     IndiaMART's UNIQUE_QUERY_ID is the run's dedupe key.
--   connectors.cursor                 the end of the last window fetched (ISO time), so the next
--                                     call starts 5 minutes before it (IndiaMART's own advice).
-- =============================================================================
ALTER TABLE connectors DROP CONSTRAINT connectors_provider_check;
ALTER TABLE connectors ADD CONSTRAINT connectors_provider_check
  CHECK (provider IN ('google', 'webhook', 'whatsapp', 'tally', 'email_in', 'telegram', 'slack', 'razorpay',
                      'indiamart'));

ALTER TABLE workflow_runs DROP CONSTRAINT workflow_runs_trigger_kind_check;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_trigger_kind_check
  CHECK (trigger_kind IN ('manual', 'email', 'webhook', 'schedule', 'upload', 'api', 'whatsapp', 'telegram',
                          'indiamart'));
