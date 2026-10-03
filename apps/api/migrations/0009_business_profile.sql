-- =============================================================================
-- Kritvia 0009 — Business profile per venture, so agents write as that business.
--
-- The agents used to sign as "Team Sitelytc" / "Truhome Finance" and assume a Delhi
-- kitchen. Each venture now carries the name customers know it by, its city, a short
-- description and the email sign-off; the workflows read these. Empty = sensible default
-- (the venture's own name, "India", "Team <name>").
-- =============================================================================
ALTER TABLE venture_settings
  ADD COLUMN business_name text CHECK (char_length(business_name) <= 120),
  ADD COLUMN city          text CHECK (char_length(city) <= 80),
  ADD COLUMN about         text CHECK (char_length(about) <= 600),
  ADD COLUMN sign_off      text CHECK (char_length(sign_off) <= 120);
