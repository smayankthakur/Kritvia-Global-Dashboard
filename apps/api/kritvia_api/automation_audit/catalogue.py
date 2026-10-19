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
        ("wf:lead_triage", "tool:gmail.send", "route:POST /ventures/{venture_id}/trust/{agent}/{action}"),
        impact=3, next="Suggest 'send without asking' to the owner once proposals pass the trust threshold "
                       "(30 clean approvals), so the agent asks for the promotion instead of waiting to be found.",
        gaps=("Trust promotion is a manual button the owner has to discover.",)),
    Job("book_meetings", "sales", "Book discovery calls", 3,
        "A call slot is picked from free calendar time and the invite waits for a yes.",
        ("wf:lead_triage", "tool:calendar.create_event"), impact=2,
        next="Let customers pick a slot from a booking link, so no approval is needed for the invite."),
    Job("prospecting", "sales", "Find new customers", 4,
        "The Prospector finds businesses on Google every day and emails them by itself (send without asking). "
        "First WhatsApp messages wait for one tap, because WhatsApp only allows them from the business's phone.",
        ("wf:prospector", "tool:places.search", "cron:fire_schedules"), impact=2,
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
        "after a yes, or by itself once the inbox assistant has earned trust.",
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
    Job("reply_reviews", "service", "Reply to Google reviews", 2,
        "New reviews are found and a reply is drafted, but a person has to post it on Google by hand.",
        ("wf:reviews",), impact=2,
        next="Post approved replies through the Google Business Profile API (needs Google's API access).",
        gaps=("No posting path: replies are copied to Google by hand.",)),

    # ------------------------------------------------------------------ finance
    Job("invoicing", "finance", "Make invoices", 2,
        "Invoices (and GST invoices) are typed or read from a photo or PDF; a person checks and saves them.",
        ("route:POST /ventures/{venture_id}/invoices/read", "route:POST /ventures/{venture_id}/invoices/gst",
         "code:apps/api/kritvia_api/routers/invoices.py::await complete_json("),
        target=3, impact=3,
        next="Draft the invoice by itself when a booking is done, a shipment is billed or a proposal is accepted; "
             "a person approves it."),
    Job("payment_reminders", "finance", "Chase payments", 3,
        "Payment reminders with a pay link are drafted daily before and after the due date; each waits for a yes.",
        ("wf:collections", "cron:fire_schedules", "tool:invoices.search"), impact=3,
        next="Earned trust for reminders whose amount matches the invoice exactly."),
    Job("record_payments", "finance", "Record payments received", 3,
        "Razorpay payments mark the invoice paid by themselves; UPI and bank payments ('I've paid') wait for the "
        "team to confirm.",
        ("route:POST /hooks/razorpay/{connector_id}", "route:POST /public/pay/{token}/paid"), impact=3,
        next="Match UPI and bank credits from a bank statement or SMS alerts to open invoices."),
    Job("bank_reconciliation", "finance", "Match the bank statement", 0,
        "Not in Kritvia.", (), target=3, impact=2,
        next="Upload a bank statement (PDF/CSV) and let an agent match credits and debits to invoices and bills."),
    Job("bills_expenses", "finance", "Pay bills and track expenses", 0,
        "Not in Kritvia: supplier bills and expenses are kept elsewhere.", (), target=3, impact=2,
        next="Read supplier bills from email or photos, file them, and remind before due dates (never pay by itself)."),
    Job("gst_returns", "finance", "GST returns", 1,
        "GST invoices and the GST profile are kept; returns are prepared outside.",
        ("route:GET,PUT /ventures/{venture_id}/gst-profile",), target=2, impact=2,
        next="Export a GSTR-1-ready sheet each month from the invoices."),
    Job("accounting_sync", "finance", "Keep the books in sync (Tally)", 1,
        "Tally data comes in by a manual XML import.",
        ("route:POST /ventures/{venture_id}/connectors/tally/import",), target=3, impact=2,
        next="A scheduled Tally sync (Tally's HTTP gateway through the desktop companion)."),
    Job("cash_forecast", "finance", "Know the cash position ahead", 2,
        "The assistant answers money questions from the numbers it has (dues, paid, overdue).",
        ("tool:business.numbers", "tool:invoices.search"), target=3, impact=2,
        next="A weekly 30/60/90-day cash view from invoices due, bills due and past payment times."),

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
        ("cron:morning_check", "cron:resume_paused", "cron:expire_approvals"), impact=2,
        gaps=("Agents switched on without a time used to sit idle silently; see the integrity checks.",)),

    # ------------------------------------------------------------------ marketing
    Job("social_posts", "marketing", "Post on social media", 0,
        "Not in Kritvia.", (), target=3, impact=2,
        next="A content calendar agent that drafts posts from offers and reviews and posts after a yes "
             "(Instagram/Facebook Graph API, Google Business Profile posts)."),
    Job("campaigns", "marketing", "WhatsApp and email campaigns", 1,
        "Approved WhatsApp templates are kept and sent one chat at a time; there are no broadcasts.",
        ("route:GET,POST /ventures/{venture_id}/whatsapp/templates",), target=3, impact=2,
        next="Campaigns to opted-in customers only, with one yes for the whole send and STOP handling."),
    Job("content_writing", "marketing", "Write marketing content", 2,
        "The assistant writes posts, offers and emails when asked.",
        ("wf:assistant",), target=3, impact=1,
        next="Learned skills that write the weekly offer by themselves for a yes."),
    Job("local_seo", "marketing", "Google listing and local SEO", 1,
        "The business's Google place is linked for reviews; the listing itself is kept up by hand.",
        ("route:GET /ventures/{venture_id}/reviews/find-place",), target=3, impact=2,
        next="Keep hours, photos and posts on the Google Business Profile in step with Kritvia."),
    Job("ads", "marketing", "Run ads", 0, "Not in Kritvia.", (), target=2, impact=1,
        next="Read ad spend and leads per source; suggest changes (never spend by itself)."),

    # ------------------------------------------------------------------ people
    Job("hiring", "people", "Hire people", 0, "Not in Kritvia.", (), target=3, impact=1,
        next="Screen CVs that arrive by email against a role and shortlist for a yes."),
    Job("attendance_payroll", "people", "Attendance and salaries", 0, "Not in Kritvia.", (), target=2, impact=1,
        next="Attendance from WhatsApp check-ins and a monthly salary sheet for the accountant."),

    # ------------------------------------------------------------------ knowledge
    Job("file_knowledge", "knowledge", "Remember everything", 4,
        "Emails, chats, documents, meetings and calls are filed into the business's memory by themselves.",
        ("wf:inbox_assistant", "route:GET,POST /ventures/{venture_id}/documents", "cron:reembed"), impact=3),
    Job("ask_business", "knowledge", "Answer questions about the business", 2,
        "Ask in the app, by voice, on Telegram or WhatsApp; answers cite the business's own records.",
        ("wf:assistant", "tool:knowledge.search", "route:POST /ventures/{venture_id}/ask"), ceiling=2, target=2,
        impact=3),
    Job("assistant_actions", "knowledge", "Do anything asked in plain words", 2,
        "One assistant uses every tool (leads, tasks, invoices, WhatsApp, calendar, calls, web, connected apps); "
        "writes and sends wait for a yes.",
        ("wf:assistant", "tool:mcp.call", "tool:approvals.waiting", "tool:leads.create"), target=3, impact=3,
        next="Let the assistant start skills and automations it suggests ('do this every Monday'), with a yes."),
    Job("learned_skills", "knowledge", "Learn a routine and repeat it", 3,
        "A routine done once becomes a skill that runs on a schedule or event and learns from edits.",
        ("route:POST /ventures/{venture_id}/skills/from-request", "cron:fire_automations"), impact=2,
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
               ("route:POST /ventures/{venture_id}/trust/{agent}/{action}",),
               "Promotion is manual: suggest it when an agent passes the threshold."),
    Capability("guardrails", "Guardrails on every outward action (secrets, injection, sensitive data)", True,
               ("code:apps/api/kritvia_api/services/guardrails.py::def protect",)),
    Capability("budgets", "AI budgets per agent, paused runs resume", True, ("cron:resume_paused",)),
    Capability("connected_apps", "Connect any app (MCP)", True, ("tool:mcp.call",)),
    Capability("plain_words", "Automations made in plain words", True,
               ("route:POST /ventures/{venture_id}/automations/understand",)),
    Capability("agent_team", "Agents work as a team with hand-offs", True, ("tool:team.handoff",)),
    Capability("voice_everywhere", "Talk to it: voice notes, phone calls, dictation", True,
               ("route:POST /ventures/{venture_id}/voice/dictate", "wf:voice_call")),
    Capability("events_bus", "One event stream every agent can react to", False, (),
               "Today each agent watches its own source (polls, webhooks, nightly finds). A shared event stream "
               "('invoice paid', 'booking done', 'lead quiet') would let any agent or skill react at once."),
    Capability("health_check", "Each business can see what its agents did and which are stuck", True,
               ("route:GET /ventures/{venture_id}/automation-health",)),
    Capability("self_check", "Kritvia checks its own automations every day and tells the owner", False, (),
               "Run the automation health check nightly for every business and send the owner the 'fix' findings "
               "(an agent on but stuck, runs with nothing to work with, drafts expiring)."),
)
