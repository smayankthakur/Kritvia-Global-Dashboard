-- =============================================================================
-- Kritvia 0013 — Support requests from the Help page's contact form.
-- Not tenant data: RLS on, no app policies; written through public.support_submit,
-- read by the operator (and emailed to SUPPORT_INBOX when SMTP is configured).
-- =============================================================================
CREATE TABLE support_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  email       text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 200),
  topic       text NOT NULL CHECK (topic IN ('question', 'problem', 'billing', 'privacy', 'security', 'sales')),
  message     text NOT NULL CHECK (char_length(message) BETWEEN 5 AND 5000),
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  handled_at  timestamptz
);
ALTER TABLE support_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_requests FORCE ROW LEVEL SECURITY;

CREATE FUNCTION public.support_submit(p_name text, p_email text, p_topic text, p_message text, p_user uuid)
RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO support_requests (name, email, topic, message, user_id)
  VALUES (p_name, p_email, p_topic, p_message, p_user) RETURNING id
$$;
GRANT EXECUTE ON FUNCTION public.support_submit(text, text, text, text, uuid) TO kritvia_app;
