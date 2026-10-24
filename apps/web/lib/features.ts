/**
 * What Kritvia does, job by job: the /features page, the landing page's link to it and /llms.txt all read this list,
 * so they say the same thing. Every line here is something the product does today (checked against the code and
 * docs/ on 21 October 2026). When a feature changes, change it here; never add one that isn't built yet.
 */
export interface Feature {
  id: string;
  title: string;
  /** The answer in two sentences: what it does and what the owner gets. */
  answer: string;
  points: string[];
  /** Which plans include it, in words. */
  plans: string;
}

export const FEATURES: Feature[] = [
  {
    id: "messages",
    title: "Answer customers on WhatsApp, email and Telegram",
    answer:
      "Every email, WhatsApp message and Telegram message lands in one place, sorted as an enquiry, payment, booking or support question. Kritvia drafts a reply in your business's voice, in Hindi, Hinglish or English, and sends it when you approve it, or straight away if you let it reply by itself.",
    points: [
      "WhatsApp needs a WhatsApp Business (Meta Cloud API) number. Replies are free-form within 24 hours of the customer's last message; after that WhatsApp requires an approved template, and Kritvia tells you instead of guessing.",
      "A Telegram bot you create with @BotFather answers customers too. It never writes first.",
      "Your website's enquiry form and IndiaMART enquiries arrive in the same inbox.",
      "Replying by itself is off until you switch it on. Orders, bookings, payments, prices that aren't in your records, discounts, refunds and complaints still wait for you, and the customer is told the team will get back to them.",
      "Customers who reply STOP are never messaged again.",
    ],
    plans: "Email and your website form on every plan. WhatsApp, Telegram and IndiaMART from Starter.",
  },
  {
    id: "proposals",
    title: "Turn enquiries into priced proposals",
    answer:
      "Kritvia scores each enquiry and prices it from your own rate card, never with a made-up number. It drafts a proposal that cites your past work, and a call invite, for you to check and send.",
    points: [
      "Fill in your rate card once; every price in a proposal is computed from it by code.",
      "Leads that go quiet get a follow-up draft on WhatsApp or email.",
      "The free trial includes 10 proposals.",
    ],
    plans: "Every plan.",
  },
  {
    id: "money",
    title: "Get paid: invoices, UPI links and payment reminders",
    answer:
      "Add invoices by typing them, from a photo or PDF, or from Tally, and each one gets a payment page with your UPI ID. The Payment reminders agent drafts a polite reminder to each customer who owes you, and sends it after your yes.",
    points: [
      "Razorpay payment links on the same page if you connect Razorpay.",
      "Upload a bank statement (CSV, Excel or PDF from any Indian bank) and Kritvia matches the money that came in to your invoices and bills, by amount and reference, in code rather than by guessing.",
      "Supplier bills are kept from a photo, a PDF or a forwarded email, and you hear about the ones due in the next 3 days.",
      "A 13-week cash forecast shows money coming in and going out, and warns you about tight weeks.",
      "GST-registered businesses can make tax invoices in Kritvia and get each month's GSTR-1 as an Excel workbook and JSON for their accountant to check and file.",
    ],
    plans: "Invoices, reminders, bills and the cash forecast on every plan. Razorpay from Starter. Tally import from Growth.",
  },
  {
    id: "bookings",
    title: "Take bookings in the chat",
    answer:
      "Set your opening hours and services once, and when a customer asks for a time, Kritvia offers two or three free slots and books the one they pick when you approve the reply. With Google Calendar connected, it checks your calendar too, so nothing is double-booked.",
    points: [
      "Up to two opening spans a day (for a lunch break), how many bookings can overlap, and how much notice you need.",
      "The day before, the Booking reminders agent drafts a reminder to each customer on the channel they booked on.",
      "If the slot was taken in the meantime, nothing is sent: Kritvia apologises and offers other times.",
    ],
    plans: "Every plan. Google Calendar from Starter.",
  },
  {
    id: "reviews",
    title: "Reply to Google reviews and ask for new ones",
    answer:
      "Each day Kritvia reads your newest Google reviews and drafts a reply: warm and specific for good ones, an apology and an invitation to talk for poor ones. After a booking or a paid invoice it drafts a thank-you that asks the customer for a review.",
    points: [
      "Low ratings are flagged to your team straight away.",
      "Nobody is asked for a review twice in 90 days.",
      "With your Google Business Profile connected, an approved reply is posted on Google for you; otherwise you copy it across.",
    ],
    plans: "Every plan.",
  },
  {
    id: "marketing",
    title: "Social posts and campaigns that don't spam",
    answer:
      "Kritvia writes a post on the days you pick, from your business description and the offers you wrote, and after your yes publishes it to your Google Business Profile and Facebook Page. Campaigns go out as one WhatsApp template or one email, to a list you see and approve once.",
    points: [
      "It never invents offers or prices.",
      "WhatsApp campaigns reach only people who agreed to hear from you; emails carry a one-click unsubscribe.",
      "Campaign ideas for upcoming festivals and occasions, and a weekly report on your ad spend from your Meta or Google Ads export.",
    ],
    plans: "Every plan. Facebook Page from Starter.",
  },
  {
    id: "calls",
    title: "Answer the phone with an AI receptionist",
    answer:
      "Kritvia answers your business's phone number in Hindi, Hinglish or Indian English, using what it knows about your business, and takes a message when it can't help. It calls customers back only after you approve the call.",
    points: [
      "Works with an Exotel number for calls within India, or a Twilio number.",
      "You set the greeting, opening hours, the longest call and a number to put callers through to.",
      "Every call is listed with a short summary and what was said, and a new caller becomes a lead.",
    ],
    plans: "Growth, Scale and Enterprise.",
  },
  {
    id: "your-kind",
    title: "An agent for your kind of business",
    answer:
      "Pick your kind of business when you sign up and the agent made for it starts switched on. Each one does the job that business repeats every day.",
    points: [
      "Lenders and DSAs: loan document checks read KYC, bank statements and salary slips on Kritvia's private model, check them against your checklist and draft a follow-up for what's missing.",
      "Cloud kitchens: a nightly plan forecasts tomorrow's demand for each dish from your Swiggy and Zomato reports and drafts purchase orders for your vendors.",
      "Exporters, importers and C&F agents: shipment files with documents, deadlines and update drafts for your buyers.",
      "Studios and agencies: lead triage and priced proposals (above).",
    ],
    plans: "From Starter (one agent for your kind); every one from Growth.",
  },
  {
    id: "team",
    title: "Hiring and attendance",
    answer:
      "Open a role with its must-haves, and Kritvia reads each CV that is uploaded or emailed in, scores it against the role and drafts an interview invite for the people you shortlist. Staff mark attendance by sending IN or OUT to your business's WhatsApp number.",
    points: [
      "A monthly attendance sheet adds it up for salaries.",
      "CVs are deleted 180 days after the role closes.",
    ],
    plans: "Hiring on every plan. Attendance by WhatsApp from Starter.",
  },
  {
    id: "assistant",
    title: "Ask for anything in plain words",
    answer:
      "Type or say a request in the app, or send it from your own WhatsApp or Telegram, and the Kritvia assistant does it across every page and agent. It looks things up straight away and asks for your yes before it changes anything.",
    points: [
      "Several tasks in one request: \"add Ravi as a lead, draft his quote and remind me on Friday\".",
      "Jobs you repeat become skills that run on a schedule or right after something happens, such as an invoice being paid.",
      "When you edit a skill's draft or send it back with a note, the skill learns from it for next time.",
    ],
    plans: "Every plan.",
  },
  {
    id: "apps",
    title: "Connect any other app",
    answer:
      "The App store connects the apps you already use, so the assistant can use them too: Notion, HubSpot, Stripe, Zapier, Jira, Asana and many more through the official MCP Registry, or any web app that publishes an OpenAPI description. Anything that changes something in another app waits for your yes.",
    points: [
      "Sign in to the app, or paste its token; tokens are stored encrypted.",
      "Apps from GitHub run only after Kritvia's team has checked them, in a locked-down sandbox.",
    ],
    plans: "Growth, Scale and Enterprise.",
  },
  {
    id: "prospecting",
    title: "Find new customers",
    answer:
      "The Prospector finds businesses on Google Maps that match your searches, writes to each one, follows up and stops the moment they reply or say no. You approve its messages until you choose to let it send by itself.",
    points: [
      "You choose the searches, such as \"restaurants in Laxmi Nagar, Delhi\", and whether to include businesses that already have a website.",
      "Anyone who says no, or asks to stop, is never contacted again.",
    ],
    plans: "Growth, Scale and Enterprise.",
  },
];

/** What every agent shares, for the end of the page. */
export const UNDERNEATH: string[] = [
  "Nothing is sent, paid or changed without your say-so: everything waits for your approval until you switch on autopilot or automatic replies. With autopilot on, agents do the routine work by themselves (replies on every plan; reminders, follow-ups, review replies and posts from Starter) and you get a summary at 8 pm; refunds, discounts, prices that aren't on your rate card, complaints, orders, payments, invoices and proposals still wait for you. Reply PAUSE from your phone to stop it.",
  "A memory of your business: upload documents (or connect Google Drive, from Starter), and every answer says which page or message it came from.",
  "A mind map of the people, companies and deals Kritvia has learned about.",
  "Each business's data is sealed off from every other and encrypted with its own key; sensitive records stay on Kritvia's own server in Mumbai.",
];
