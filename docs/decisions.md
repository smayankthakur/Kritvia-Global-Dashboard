# As-built decisions (ADR log)

Each entry: what the plan said, what was built, why. All are reversible.

## ADR-001 Postgres on the VM, not Supabase
No idle pausing or storage caps; identical to what ships into a client VPC. Auth is therefore FastAPI-issued (argon2 hashes, short-lived JWT access tokens + rotating refresh tokens with reuse detection) rather than Supabase Auth.

## ADR-002 arq + Valkey for the queue
Plan default. The API enqueues `execute_run`; a per-minute sweeper re-dispatches anything queued or with an expired lease, so a lost queue message only delays a run by ≤ 1 minute. Switching to Procrastinate touches only `apps/worker` and `engine/dispatch.py`.

## ADR-003 Own durable workflow engine instead of the LangGraph library
The plan named LangGraph with its Postgres checkpointer. LangGraph's checkpoint tables carry no `org_id`/`venture_id`, so they cannot sit under the same forced RLS as every other tenant table, and run state (which holds loan data) would be stored outside envelope encryption. Principle 1 ("security is foundation") wins. `kritvia_api/engine` implements the LangGraph ideas that matter — named step graph, checkpoint after every step, interrupts that park a run for days, resume on decision — in ~500 lines:

* run state encrypted with the venture DEK, stored in `workflow_runs` under RLS;
* the worker executes a run **as the venture's agent service account** (role `agent_runtime`: may write, can never approve), so RLS bounds every agent to one venture and the audit log names the agent;
* runs are claimed with leases; two workers can never execute the same run; an expired lease is recovered by the sweeper;
* approvals are rows created at the interrupt and decided only through `decide_approval()` (role check, agents refused, trust counters updated, run re-queued — one transaction).

If LangGraph is wanted later for complex agent loops *inside* a step, it can run within a step with an in-memory checkpointer.

## ADR-004 Tools execute the approved payload, at most once
A write/send tool is invoked with an approval id, not arguments. The tool reads the final (possibly human-edited) payload back from the database, and claims execution with `executed_at` under row lock; a DB trigger forbids executing an undecided or rejected approval and forbids executing twice. Every message is also written to `outbox_messages` with `UNIQUE(approval_id)`. Trade-off: if the provider call fails after the claim, the step fails visibly and the email is not auto-retried (a duplicate email to a client is worse than a visible failure).

## ADR-005 Retrieval over encrypted chunk text
Chunk text, facts and raw files are encrypted with the venture DEK; retrieval uses pgvector similarity (embeddings are stored in clear — they are not reversible to text) plus graph hops through facts about entities named in the question. No full-text index over plaintext exists by design.

## ADR-006 Role-restricted knowledge enforced in the database
`documents`, `chunks`, `entities`, `edges`, `facts`, `loan_applications`, `loan_documents` and sensitive `approvals` have RESTRICTIVE policies: a row with `access_roles` is visible only to members holding one of those roles (plus the venture's agent runtime). Even the org owner needs the `loan_officer` role to see loan files. DPDP erasure therefore runs as the agent runtime so it is complete regardless of who clicked.

## ADR-007 Deterministic numbers
* Sitelytc prices: rate card × quantities (quantities are extracted; arithmetic is code). The proposal agent is told not to write amounts; any currency amount in its text triggers one redraft, then offending lines are removed. The pricing table is appended by code.
* Kitchen: forecast (`statsforecast` AutoETS when ≥ 28 days of history, else a weighted same-weekday model with a clamped trend), BOM and pack rounding run as allow-listed jobs in the sandbox, money in `Decimal`. The model may suggest an event multiplier only inside [0.5, 2.0]; anything outside fails validation and falls back to 1.0.
* Truhome: checklist presence, document age, cross-document consistency (name similarity with initials, DOB, PAN, statement coverage) are code; the private model is consulted only for ambiguous name pairs (similarity 0.6–0.9).

## ADR-008 Sandbox runs allow-listed jobs, not arbitrary code
Layer 3 of the defence is an allow-list: only jobs baked into the `kritvia-sandbox-jobs` image run (`forecast`, `bom`, plus `echo`/`net_probe` for health). Arbitrary agent-written code is a Phase 2 decision. `LocalSandbox` (subprocess, no network isolation) exists for tests and laptops and refuses `ENVIRONMENT=production`.

## ADR-009 Data principals are pseudonymous
Consents and DPDP requests reference people by an HMAC of the normalised identifier under a key derived from the master KEK, plus a masked label (`m***@example.in`). The identifier for a request is kept only encrypted inside the request.

## ADR-010 Web: BFF with httpOnly cookies
The browser never sees a token. Next.js route handlers log in server-side and set httpOnly cookies; `/api/k/*` proxies to the API adding the bearer, refreshes once on 401 (merging concurrent refreshes so reuse detection doesn't revoke the session), and refuses cross-origin writes. CSP uses a per-request nonce.

## ADR-011 Service accounts can never log in
`auth_lookup` reports them inactive and they have no password hash; `decide_approval` and `set_autonomy` refuse them; `auth_issue_refresh` never issues them tokens.

## ADR-012 Security review before dogfooding (migration 0006)
An adversarial review found seven issues exploitable through the API; each now has a regression test in
`tests/test_security_regressions.py` that replays the original exploit and asserts it fails.

| Finding | Fix |
|---|---|
| Restricted/sensitive documents could be retrieved by the lead-triage agent, sent to a hosted model and quoted into a draft every viewer reads | agent retrieval excludes restricted and sensitive chunks unless the workflow declares it handles sensitive data; if anything sensitive slips through, the draft uses the private tier and becomes a sensitive approval |
| A venture admin without `loan_officer` could read applicant PII through a DPDP access export | access exports run as the requesting user (restricted records are counted, not exported); erasure still runs as the agent runtime so it is complete |
| Membership by email allowed invite squatting (register the new hire's address first) | invitations: one-time token sent out of band **and** the accepting account must have the invited email; direct add only for yourself or existing members |
| Any writer could start a workflow on a record they can't see (agents run with wider access) | `Workflow.authorize_input` runs in the starting user's RLS transaction (loan verification requires seeing the application; meeting digest requires a visible meeting recording) |
| Google OAuth consent link could be completed by another person into the attacker's venture | the callback is a web route; the flow is bound to the starting browser by an httpOnly nonce cookie and to the starting user |
| Existence oracle on role-restricted entity names | entity identity includes its access roles |
| Email enumeration via add-member | owner check first, one error for every failure |

Also hardened: error text stored on runs never includes input values; emailed loan documents are accepted only from the applicant's address; access tokens die on password change or deactivation; the app role can no longer read password hashes; approval execution stamps and contents are immutable; approvals cannot be inserted pre-decided, with non-approving roles, or auto-approved when sensitive; only admins and the agent runtime can write connector credentials.

## Known limitations / next
* Approval payloads and some kind-specific responses are `dict` in the OpenAPI schema (the web asserts shapes); tighten with typed models per action.
* Weather signal for the kitchen is not wired (licence check pending).
* PaddleOCR is supported when installed; the images ship Tesseract (eng+hin) because PaddleOCR ARM wheels are unreliable.
* The web proxy's refresh de-duplication is per process — run one web instance, or add a shared lock.
* Correction and nomination DPDP requests are tracked but executed manually.
* **Raw SQL as `kritvia_app` is fully trusted.** The request context (`app.user_id`) is a GUC the role can set, and the auth functions (`auth_lookup`, `auth_issue_refresh`) and worker routing functions are executable by it. The API never exposes raw SQL and every query is parameterised, but a future SQL-injection bug would be a full compromise. Phase 2: separate `kritvia_auth` and `kritvia_worker` roles, and a signed request context set through a SECURITY DEFINER setter.
* A writer with raw SQL could insert a garbage `tenant_keys` version and break encryption for a venture (DoS, not disclosure); move DEK creation behind a definer function when the KMS provider lands.
