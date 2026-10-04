-- =============================================================================
-- Kritvia 0018 — Hardening from the pre-launch security review (4 Oct 2026).
--
--   * public.set_org_plan is SECURITY DEFINER with no caller check, and the app never calls it
--     (plans change through the billing webhook's own path): the app role loses EXECUTE.
--   * ticket_for_run moves a board card; it now needs write access to the venture, not just read.
-- =============================================================================
REVOKE EXECUTE ON FUNCTION public.set_org_plan(uuid, text, timestamptz) FROM kritvia_app;
REVOKE EXECUTE ON FUNCTION public.set_org_plan(uuid, text, timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.ticket_for_run(p_run uuid, p_status text, p_note text DEFAULT NULL) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE tickets SET status = p_status, note = coalesce(left(p_note, 500), note), updated_at = now(),
         finished_at = CASE WHEN p_status IN ('done', 'cancelled') THEN now() ELSE finished_at END
   WHERE run_id = p_run AND venture_id = ANY (private.writable_ventures())
$$;
