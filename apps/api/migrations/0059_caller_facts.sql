-- =============================================================================
-- 0059 What callers can be told.
--
--   phone_settings.caller_facts   the owner's own words for the phone assistant: services, prices, address,
--                                 policies. The assistant answers from these first; its other sources are
--                                 the business's details, opening hours and its own documents and notes
--                                 (never emails, meetings, proposals or reports).
-- =============================================================================
ALTER TABLE phone_settings
  ADD COLUMN caller_facts text CHECK (char_length(caller_facts) <= 2000);
