"""Every job a small business does, and how far Kritvia does it by itself today.

The autonomy ladder (`level`):

    0  Not in Kritvia     done by hand or in another tool
    1  Kept in Kritvia    Kritvia records it; a person does the work
    2  AI when asked      the AI does it when a person starts it (a button, an upload, a question)
    3  Autopilot, with a yes
                          it starts by itself (a clock, a message, a call); a person approves what goes out
    4  Runs by itself     it starts and finishes by itself, inside guardrails: its output stays inside the
                          business, or the agent has earned the right to send without asking

`ceiling` is the most Kritvia should ever do for that job (calls, loan papers, web forms and money keep a
person in the loop). `target` is where a fully AI-run operating system should take it next; `next` says how.

Evidence (`evidence`) points into the real code, and the audit checks every pointer:

    wf:<workflow>        a registered workflow          tool:<name>     a registered tool
    route:<METHOD> <p>   an API route (OpenAPI paths)   cron:<job>      a worker cron job
    code:<file>::<text>  a file (from the repo root) that contains <text>

A job at level 3 or 4 must show how it starts by itself: a workflow whose trigger isn't a person's
request, a cron job, a webhook route, or a database trigger.
"""
from __future__ import annotations

from dataclasses import dataclass, field

LEVELS = {
    0: "Not in Kritvia",
    1: "Kept in Kritvia",
    2: "AI when asked",
    3: "Autopilot, with a yes",
    4: "Runs by itself",
}

DOMAINS = {
    "sales": "Sales and leads",
    "service": "Customer service",
    "finance": "Money",
    "ops": "Operations",
    "marketing": "Marketing",
    "people": "People and HR",
    "knowledge": "Knowledge and the assistant",
}


@dataclass(frozen=True)
class Job:
    key: str
    domain: str
    title: str
    level: int
    how: str                      # what happens today, in plain words
    evidence: tuple[str, ...] = ()
    ceiling: int = 4
    target: int = 4
    impact: int = 2               # 1 nice to have, 2 useful, 3 core to a small business
    next: str = ""                # what raises it towards the target
    gaps: tuple[str, ...] = field(default_factory=tuple)   # known holes, honest


JOBS: tuple[Job, ...] = (
    # ------------------------------------------------------------------ sales
    Job("capture_enquiries", "sales", "Catch every enquiry", 4,
        "Emails, website forms, WhatsApp, Telegram, IndiaMART and phone calls become leads with no one typing.",
        ("wf:lead_triage", "wf:inbox_assistant", "cron:poll_gmail", "cron:poll_indiamart",
         "route:POST /hooks/{connector_id}", "route:POST /hooks/whatsapp", "route:POST /public/email-in",
         "route:POST /hooks/voice/twilio/{connector_id}/incoming"),
        impact=3),
    Job("qualify_leads", "sales", "Score and qualify leads", 4,
        "Lead triage reads each enquiry, removes spam and duplicates, scores it and marks it qualified.",
        ("wf:lead_triage", "tool:crm.update_lead"), impact=3),
    Job("proposals", "sales", "Send quotes and proposals", 3,
        "A priced proposal is drafted from the rate card for every qualified lead; it goes out after a yes.",
        ("wf:lead_triage", "tool:gmail.send", "route:POST /ventures/{venture_id}/trust/{agent}/{action}",
         "code:apps/api/kritvia_api/services/trust_ask.py::async def maybe_ask"),
        impact=3, next="Once the owner lets it, proposals within the rate card go out by themselves; prices it "
                       "isn't sure of still wait."),
    Job("book_meetings", "sales", "Book discovery calls", 3,
        "A call slot is picked from free calendar time and the invite waits for a yes.",
        ("wf:lead_triage", "tool:calendar.create_event"), impact=2,
        next="Let customers pick a slot from a booking link, so no approval is needed for the invite."),
    Job("prospecting", "sales", "Find new customers", 4,
        "The Prospector finds businesses on Google every day. Email first: businesses with a website are read for "
        "a contact email and emailed by themselves; businesses without one get a WhatsApp draft for one tap, "
        "because WhatsApp only allows a first message from the business's own phone.",
        ("wf:prospector", "tool:places.search", "cron:fire_schedules",
         "code:apps/api/kritvia_api/services/contact_email.py::async def find"), impact=2,
        gaps=("First WhatsApp touches need one tap from the owner's phone (Meta rule).",)),
    Job("lead_followups", "sales", "Follow up quiet leads", 3,
        "WhatsApp follow-ups and custom workflows find quiet chats and leads and draft a nudge for a yes.",
        ("wf:whatsapp_followup", "wf:custom", "tool:whatsapp.template", "cron:fire_schedules"), impact=3,
        next="Email follow-ups for quiet email leads (today only WhatsApp chats are followed up by default)."),
    Job("answer_calls", "sales", "Answer the business phone", 4,
        "The AI receptionist answers live, in Hindi or English, takes messages and bookings, and puts callers "
        "through in opening hours. Callers become leads and messages become tasks.",
        ("route:POST /hooks/voice/twilio/{connector_id}/incoming",
         "code:apps/api/kritvia_api/routers/calls.py::/hooks/voice/stream/exotel/{connector_id}",
         "code:apps/api/kritvia_api/services/voice_calls.py::def turn"), impact=3,
        gaps=("Needs a paid ExoPhone with KYC for real customers; trial numbers only take verified callers.",)),
    Job("outbound_calls", "sales", "Call customers back", 2,
        "Kritvia phones a customer when someone asks it to, after a yes on the exact opening line.",
        ("wf:voice_call", "tool:voice.call"), ceiling=3, target=3, impact=2,
        next="Offer a call from each 'Call back' task the receptionist creates (still one yes per call; "
             "needs the DLT registration).",
        gaps=("Every call needs a yes by design (TRAI rules); real dialling waits for the DLT Principal Entity ID.",)),
    Job("sales_reports", "sales", "Sales and pipeline reports", 4,
        "Plain-words automations send the owner numbers on a schedule ('every Monday, last week's leads').",
        ("wf:automation", "cron:fire_automations", "tool:business.numbers"), impact=2),

    # ------------------------------------------------------------------ service
    Job("reply_messages", "service", "Reply to customer messages", 3,
        "Every email, WhatsApp and Telegram message gets a drafted reply in the customer's language; it goes out "
        "after a yes (drafts about to expire are nudged to the owner's phone), or by itself once the inbox "
        "assistant has earned trust.",
        ("wf:inbox_assistant", "tool:gmail.send", "tool:whatsapp.send", "tool:telegram.send"), impact=3,
        next="Turn on earned trust for routine replies (hours, location, status) and keep a yes for prices."),
    Job("handoff_human", "service", "Hand a customer to a person", 4,
        "When a customer asks for a person, the chat is handed over and the team gets a push; drafts stop.",
        ("wf:inbox_assistant", "route:PUT /ventures/{venture_id}/whatsapp/chats/{chat_id}/handler"), impact=2),
    Job("bookings_from_chat", "service", "Take bookings from chats", 3,
        "A booking asked for in a chat is drafted with the reply and saved when the reply is approved.",
        ("wf:inbox_assistant", "route:GET,POST /ventures/{venture_id}/bookings"), impact=2,
        next="Confirm a booking by itself when the slot is free and the service is on the list (earned trust)."),
    Job("booking_reminders", "service", "Remind customers of bookings", 3,
        "Tomorrow's bookings get a reminder drafted every evening, in the channel they booked from.",
        ("wf:booking_reminders", "cron:fire_schedules"), impact=2,
        next="Fixed-text reminders are safe to send without asking: offer earned trust for them first."),
    Job("ask_reviews", "service", "Ask happy customers for reviews", 3,
        "After a booking is done or an invoice is paid, a review request with the Google link waits for a yes.",
        ("wf:reviews", "cron:fire_schedules"), impact=2,
        next="Earned trust for review requests: fixed text, one per customer, only after a done booking or a paid "
             "invoice."),
    Job("reply_reviews", "service", "Reply to Google reviews", 3,
        "New reviews on the business's Google profile get a drafted reply that is posted on Google after a yes "
        "(Business Profile linked); otherwise the draft is copied into Google by hand.",
        ("wf:reviews", "tool:google.review_reply", "cron:fire_schedules",
         "route:POST /ventures/{venture_id}/review-replies/{reply_id}/post"), impact=2,
        next="Earned trust for 4-5 star thank-you replies.",
        gaps=("Needs Google's one-time approval of Kritvia for the Business Profile APIs.",)),

    # ------------------------------------------------------------------ finance
    Job("invoicing", "finance", "Make invoices", 3,
        "A booking marked done or a lead marked won drafts its invoice by itself (from the service price or the "
        "accepted proposal); a person checks it and presses Issue. Others are typed or read from a photo or PDF.",
        ("route:POST /ventures/{venture_id}/invoices/read", "route:POST /ventures/{venture_id}/invoices/gst",
         "code:apps/api/kritvia_api/routers/invoices.py::await complete_json(",
         "code:apps/api/migrations/0061_earn_trust.sql::CREATE TRIGGER bookings_done_invoice",
         "code:apps/api/migrations/0061_earn_trust.sql::CREATE TRIGGER leads_won_invoice"),
        target=4, impact=3,
        next="Issue drafts by themselves once a business has issued enough unchanged (earned trust for invoices), "
             "and draft from shipments and kitchen orders too.",
        gaps=("Drafts are not made from shipments or kitchen orders yet.",)),
    Job("payment_reminders", "finance", "Chase payments", 3,
        "Payment reminders with a pay link are drafted daily before and after the due date; each waits for a yes.",
        ("wf:collections", "cron:fire_schedules", "tool:invoices.search"), impact=3,
        next="Earned trust for reminders whose amount matches the invoice exactly."),
    Job("record_payments", "finance", "Record payments received", 3,
        "Razorpay payments mark the invoice paid by themselves; UPI and bank payments ('I've paid') wait for the "
        "team to confirm.",
        ("route:POST /hooks/razorpay/{connector_id}", "route:POST /public/pay/{token}/paid"), impact=3,
        next="Match UPI and bank credits from a bank statement or SMS alerts to open invoices."),
    Job("bank_reconciliation", "finance", "Match the bank statement", 3,
        "The bank's statement email (forwarded, or read from Gmail) or an uploaded CSV, Excel or PDF is read by "
        "itself, every credit matched to an invoice and every debit to a bill, and the owners told; one tap "
        "records the sure matches (one by one for a forwarded statement nobody could vouch for).",
        ("route:POST /ventures/{venture_id}/bank/statements", "route:POST /ventures/{venture_id}/bank/confirm-sure",
         "route:POST /public/email-in", "code:apps/api/kritvia_api/services/pollers.py::async def statement_mail(",
         "code:apps/api/kritvia_api/services/bank.py::def match(", "tool:bank.unmatched"), target=3, impact=2,
        next="An account aggregator feed (RBI AA) instead of statement emails.",
        gaps=("A password-protected PDF needs the statement password saved on Money → Bank.",)),
    Job("bills_expenses", "finance", "Pay bills and track expenses", 3,
        "Supplier bills are typed, read from a photo or PDF, or filed from a forwarded email; owners are reminded "
        "before they fall due, and a bank debit marks them paid. Kritvia never pays.",
        ("route:GET,POST /ventures/{venture_id}/bills", "route:POST /ventures/{venture_id}/bills/read",
         "cron:bills_due", "route:POST /public/email-in",
         "code:apps/api/kritvia_api/services/pollers.py::async def _bill_forwarded(", "tool:bills.search"),
        target=3, impact=2,
        next="Expense categories into a monthly profit view."),
    Job("gst_returns", "finance", "GST returns", 2,
        "Each month's GSTR-1 (b2b, b2cl, b2cs, HSN, documents) is built from the tax invoices, as the GST offline "
        "tool's Excel and as JSON; owners are told on the 3rd. Kritvia doesn't file.",
        ("route:GET,PUT /ventures/{venture_id}/gst-profile", "route:GET /ventures/{venture_id}/gst/gstr1",
         "route:GET /ventures/{venture_id}/gst/gstr1/file", "cron:gstr1_ready"), ceiling=3, target=2, impact=2,
        next="GSTR-3B summary and purchase-side (ITC) matching from bills."),
    Job("accounting_sync", "finance", "Keep the books in sync (Tally)", 3,
        "The Tally companion on the Tally PC sends Tally's Day Book to Kritvia and takes Kritvia's invoices into "
        "Tally as Sales vouchers, every hour, with the business's sync key.",
        ("route:POST /ventures/{venture_id}/connectors/tally/import", "route:POST /hooks/tally/{connector_id}/import",
         "route:GET /hooks/tally/{connector_id}/sales"), target=3, impact=2,
        next="Receipts (payments) into Tally as well as sales.",
        gaps=("The companion runs on the Tally PC (Windows Task Scheduler); Tally has no cloud API.",)),
    Job("cash_forecast", "finance", "Know the cash position ahead", 3,
        "Thirteen weeks ahead from open invoices (when each customer usually pays), bills, salaries and fixed "
        "costs, from the last statement's balance; every Monday the owners hear the next 30/60/90 days and any "
        "week that dips below their level.",
        ("route:GET /ventures/{venture_id}/cash/forecast", "route:GET,PUT /ventures/{venture_id}/cash/settings",
         "cron:cash_week", "tool:business.numbers"), target=3, impact=2,
        next="Suggest which dues to chase first when a tight week is coming."),

    # ------------------------------------------------------------------ operations
    Job("tasks_from_work", "ops", "Turn conversations into tasks", 4,
        "Promises and to-dos in emails, chats, meetings and calls become task cards by themselves.",
        ("code:apps/api/migrations/0024_task_boards.sql::CREATE TRIGGER facts_card", "wf:meeting_digest",
         "tool:tasks.create"), impact=3),
    Job("meeting_notes", "ops", "Meeting notes and actions", 3,
        "An uploaded recording is transcribed, summarised and its actions become tasks.",
        ("wf:meeting_digest", "route:POST /ventures/{venture_id}/meetings"), impact=2,
        next="Pick up recordings from Google Meet / Drive by themselves instead of an upload."),
    Job("team_checkins", "ops", "Team check-ins and hand-offs", 3,
        "Team leads check in on set days, report to the owner and hand work to other agents; drafts wait for a yes.",
        ("cron:fire_automations", "tool:team.handoff", "route:POST /ventures/{venture_id}/team/{role}/check-in"),
        impact=2, next="Let a team lead's routine hand-offs (e.g. a quiet lead to follow-ups) go without asking."),
    Job("purchase_planning", "ops", "Plan stock and purchase orders", 3,
        "For kitchens: tomorrow's demand is forecast nightly, prep lists made, and purchase orders wait for a yes.",
        ("wf:kitchen_daily", "tool:sandbox.forecast", "tool:sandbox.bom", "cron:fire_schedules"), impact=2,
        next="Let regular vendor orders within a usual range go without asking (earned trust)."),
    Job("shipment_watch", "ops", "Watch shipments and deadlines", 4,
        "For traders: cut-offs, ETAs, LC and realisation dates are checked every morning and the team is told.",
        ("wf:trade_watch", "cron:fire_schedules"), impact=2),
    Job("shipment_updates", "ops", "Update customers on shipments", 2,
        "A status update to the buyer is drafted when someone presses Send update.",
        ("wf:trade_update",), target=3, impact=2,
        next="Draft the update by itself when a shipment changes stage (sailed, arrived, cleared)."),
    Job("document_checks", "ops", "Check customer documents", 3,
        "Loan papers uploaded or emailed are classified, read and checked; the follow-up waits for the loan "
        "officer (private model only).",
        ("wf:loan_verification", "cron:poll_gmail"), ceiling=3, target=3, impact=2),
    Job("web_tasks", "ops", "Do work on websites and portals", 2,
        "The browser agent reads sites and fills forms when asked; every submit needs a yes.",
        ("wf:browser", "tool:web.browse", "tool:browser.submit"), ceiling=3, target=3, impact=1,
        next="Let skills and team leads start browser jobs on a schedule (still a yes per submit)."),
    Job("owner_briefing", "ops", "Owner's daily briefing", 4,
        "Automations and the chat front door (/today, /week, /waiting) tell the owner what happened and what waits.",
        ("wf:automation", "code:apps/api/kritvia_api/services/front_door.py::/today"), impact=3),
    Job("system_alerts", "ops", "Alerts when automation breaks", 4,
        "A missing overnight plan raises an alert; budget-paused runs resume; expired drafts end cleanly.",
        ("cron:morning_check", "cron:resume_paused", "cron:expire_approvals", "cron:self_check"), impact=2),

    # ------------------------------------------------------------------ marketing
    Job("social_posts", "marketing", "Post on social media", 3,
        "On the days the owner picks, a post is written from the business and its offers and posted to the "
        "Google profile and the Facebook Page after a yes.",
        ("wf:social", "tool:social.post", "cron:fire_schedules", "route:PUT /ventures/{venture_id}/connectors/facebook"),
        target=3, impact=2, next="Instagram posts with a photo; earned trust for posts without offers.",
        gaps=("Instagram isn't posted to yet (it needs a photo per post).",)),
    Job("campaigns", "marketing", "WhatsApp and email campaigns", 3,
        "Once a week Kritvia looks for a festival two or three weeks away or a slow fortnight and writes an email "
        "campaign; it goes to customers only, with one yes for the whole fixed list; STOP and one-click "
        "unsubscribe are honoured.",
        ("wf:campaign_ideas", "wf:campaign", "tool:campaign.send", "route:GET,POST /ventures/{venture_id}/campaigns",
         "route:POST /public/campaign-unsubscribe"), target=3, impact=2,
        next="Suggest WhatsApp campaigns too, with the business's approved marketing template."),
    Job("content_writing", "marketing", "Write marketing content", 3,
        "Posts are written on the owner's days and festival or slow-week emails once a week, by themselves, for a "
        "yes; the assistant writes anything else when asked.",
        ("wf:social", "wf:campaign_ideas", "wf:assistant"), target=3, impact=1,
        next="Learn the owner's edits so drafts need fewer changes."),
    Job("local_seo", "marketing", "Google listing and local SEO", 3,
        "Every week the Google Business Profile is checked against Kritvia: different opening hours are put on "
        "Google after a yes, a missing website or phone is pointed out, and posts go up on the owner's days.",
        ("wf:google_listing", "tool:google.listing_update", "wf:social",
         "route:GET /ventures/{venture_id}/reviews/find-place"), target=3, impact=2,
        next="Photos from the business's own uploads, after a yes."),
    Job("ads", "marketing", "Run ads", 2,
        "Uploaded Meta and Google Ads reports are set against the leads each campaign brought (UTM tags, gclid, "
        "fbclid on website-form leads): cost per lead and per sale, and plain-words advice. Kritvia never spends.",
        ("route:POST /ventures/{venture_id}/ads/reports", "route:GET /ventures/{venture_id}/ads/summary",
         "route:POST /ventures/{venture_id}/ads/advice", "tool:ads.summary",
         "code:apps/api/kritvia_api/workflows/lead_triage.py::def ad_tags("), ceiling=3, target=2, impact=1,
        next="Read spend from the ad accounts directly (Meta Marketing API / Google Ads API, read-only)."),

    # ------------------------------------------------------------------ people
    Job("hiring", "people", "Hire people", 3,
        "Every CV for an open role (uploaded, or emailed with the role's code) is read and scored against it with "
        "reasons; shortlisted people get an interview invite after a yes. It never rejects anyone by itself.",
        ("wf:hiring", "route:POST /ventures/{venture_id}/jobs/{job_id}/candidates", "route:POST /public/email-in",
         "code:apps/api/kritvia_api/services/people.py::async def cv_forwarded("), target=3, impact=1,
        next="Post the role on job boards and schedule interviews from free calendar time."),
    Job("attendance_payroll", "people", "Attendance and salaries", 3,
        "Staff send IN / OUT to the business's WhatsApp; owners hear at noon who hasn't come in; the month adds up "
        "to a salary estimate sheet for the accountant.",
        ("route:POST /hooks/whatsapp", "cron:attendance_check", "route:GET /ventures/{venture_id}/attendance/sheet",
         "code:apps/api/kritvia_api/services/people.py::async def whatsapp_checkin("), target=3, impact=1,
        next="Leave requests on WhatsApp, approved by the owner with one tap."),

    # ------------------------------------------------------------------ knowledge
    Job("file_knowledge", "knowledge", "Remember everything", 4,
        "Emails, chats, documents, meetings and calls are filed into the business's memory by themselves.",
        ("wf:inbox_assistant", "route:GET,POST /ventures/{venture_id}/documents", "cron:reembed"), impact=3),
    Job("ask_business", "knowledge", "Answer questions about the business", 2,
        "Ask in the app, by voice, on Telegram or WhatsApp; answers cite the business's own records.",
        ("wf:assistant", "tool:knowledge.search", "route:POST /ventures/{venture_id}/ask"), ceiling=2, target=2,
        impact=3),
    Job("assistant_actions", "knowledge", "Do anything asked in plain words", 3,
        "One prompt, from the app, WhatsApp, Telegram or voice, reaches every page and agent: the assistant finds "
        "any of the app's own actions, plans several tasks, reads at once, sets up routines, and changes things "
        "after a yes (run as the person who approves).",
        ("wf:assistant", "tool:kritvia.find", "tool:kritvia.read", "tool:kritvia.do", "tool:routines.create",
         "tool:mcp.call", "tool:approvals.waiting", "tool:leads.create",
         "route:POST /hooks/telegram/{connector_id}"), target=3, impact=3,
        next="Earned trust for routine app changes (e.g. marking attendance) once they're always approved unchanged."),
    Job("learned_skills", "knowledge", "Learn a routine and repeat it", 3,
        "A routine done once becomes a skill that runs on a schedule, or right after something happens, and learns "
        "from edits. The assistant sets up the routines it suggests, after one yes.",
        ("route:POST /ventures/{venture_id}/skills/from-request", "cron:fire_automations", "tool:routines.create",
         "cron:dispatch_events"), impact=2,
        next="Earned trust per skill once its last runs went out unchanged."),
)


# Things every AI operating system needs underneath the jobs. `done` is checked against the code.
@dataclass(frozen=True)
class Capability:
    key: str
    title: str
    done: bool
    evidence: tuple[str, ...]
    next: str = ""


PLATFORM: tuple[Capability, ...] = (
    Capability("approvals_anywhere", "Approve from the phone (Telegram, WhatsApp, Slack)", True,
               ("route:POST /ventures/{venture_id}/approver-links/telegram", "route:POST /hooks/slack/interact")),
    Capability("earned_trust", "Agents earn the right to act alone", True,
               ("route:POST /ventures/{venture_id}/trust/{agent}/{action}",
                "code:apps/api/kritvia_api/services/trust_ask.py::async def maybe_ask"),
               "The agent asks the owners once when its streak earns it; one tap on the Trust page lets it."),
    Capability("guardrails", "Guardrails on every outward action (secrets, injection, sensitive data)", True,
               ("code:apps/api/kritvia_api/services/guardrails.py::def protect",)),
    Capability("budgets", "AI budgets per agent, paused runs resume", True, ("cron:resume_paused",)),
    Capability("connected_apps", "Connect any app (MCP)", True, ("tool:mcp.call",)),
    Capability("app_store", "App store: any MCP server, GitHub project or web app with an API", True,
               ("route:GET /app-store", "route:POST /ventures/{venture_id}/apps/oauth/start",
                "route:POST /ventures/{venture_id}/apps/hosted", "route:POST /ventures/{venture_id}/apps/github",
                "route:POST /hooks/apps/{app_id}", "cron:sync_app_store",
                "code:services/mcp-runner/app.py::--runtime={RUNTIME}",
                "code:apps/api/kritvia_api/services/openapi_app.py::def parse("),
               "Apps by address (token, own header, basic or OAuth sign-in), the official MCP Registry, web apps by "
               "their OpenAPI description, and packages Kritvia's team approved, run in gVisor with only their "
               "approved sites."),
    Capability("always_on", "Works 24x7: retries, heartbeats, self-healing, an outside monitor", True,
               ("route:GET /livez", "cron:heartbeat", "cron:watchdog_check",
                "code:apps/api/kritvia_api/engine/runner.py::def passing(",
                "code:infra/scripts/healthcheck.sh::livez", "code:infra/cloudflare/uptime-worker.js::async scheduled(")),
    Capability("plain_words", "Automations made in plain words", True,
               ("route:POST /ventures/{venture_id}/automations/understand",)),
    Capability("agent_team", "Agents work as a team with hand-offs", True, ("tool:team.handoff",)),
    Capability("voice_everywhere", "Talk to it: voice notes, phone calls, dictation", True,
               ("route:POST /ventures/{venture_id}/voice/dictate", "wf:voice_call")),
    Capability("events_bus", "One event stream every agent can react to", True,
               ("cron:dispatch_events", "route:GET /ventures/{venture_id}/events", "tool:events.recent",
                "code:apps/api/migrations/0063_operating_system.sql::CREATE TRIGGER invoices_events"),
               "Database triggers write every lead, invoice, payment, booking, bill, review, opt-out and application; "
               "skills react within a minute and owners get 'tell me when' alerts."),
    Capability("health_check", "Each business can see what its agents did and which are stuck", True,
               ("route:GET /ventures/{venture_id}/automation-health",)),
    Capability("self_check", "Kritvia checks its own automations every day and tells the owner", True,
               ("cron:self_check", "cron:nudge_expiring", "code:apps/api/kritvia_api/services/self_check.py::def morning")),
)
