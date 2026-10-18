import {
  Activity,
  AudioLines,
  BookOpen,
  Bot,
  BrainCircuit,
  Building2,
  CalendarCheck,
  CalendarDays,
  ChartColumn,
  ChefHat,
  CircleUser,
  ClipboardCheck,
  CreditCard,
  Database,
  FileText,
  Gauge,
  Gift,
  Globe,
  Handshake,
  HeartPulse,
  Inbox,
  KeyRound,
  IndianRupee,
  Landmark,
  LockKeyhole,
  LayoutDashboard,
  LifeBuoy,
  ListChecks,
  MessageCircle,
  MessageSquareText,
  Mic,
  Network,
  PhoneCall,
  Receipt,
  Repeat,
  ScrollText,
  Settings,
  Ship,
  ShieldCheck,
  Sparkles,
  Star,
  TrendingUp,
  Users,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import type { VentureKind } from "./access";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Other route prefixes that should highlight this item. */
  match?: string[];
}

export function ventureNav(ventureId: string, kind: VentureKind): { domain: NavItem[]; common: NavItem[] } {
  const v = `/v/${ventureId}`;
  const software: NavItem[] = [
    { label: "Leads", href: `${v}/leads`, icon: Users },
    { label: "Proposals", href: `${v}/proposals`, icon: FileText },
    { label: "Rate card", href: `${v}/rate-card`, icon: Receipt },
  ];
  const finance: NavItem[] = [
    { label: "Loan applications", href: `${v}/loans`, icon: Landmark },
    { label: "Checklists", href: `${v}/checklists`, icon: ClipboardCheck },
  ];
  const kitchen: NavItem[] = [
    { label: "Daily plan", href: `${v}/kitchen/plan`, icon: ChefHat },
    { label: "Reference data", href: `${v}/kitchen/reference`, icon: Database },
    { label: "Sales & stock", href: `${v}/kitchen/sales`, icon: TrendingUp },
    { label: "Events", href: `${v}/kitchen/events`, icon: CalendarDays },
  ];
  const trade: NavItem[] = [
    { label: "Shipments", href: `${v}/shipments`, icon: Ship, match: [`${v}/shipments`] },
    { label: "Trade profile", href: `${v}/trade-profile`, icon: Globe },
    { label: "Leads", href: `${v}/leads`, icon: Users },
    { label: "Proposals", href: `${v}/proposals`, icon: FileText },
    { label: "Rate card", href: `${v}/rate-card`, icon: Receipt },
  ];
  // A "general" business gets the leads screens (any business can run lead triage with a
  // rate card); the loan and kitchen screens only make sense for those kinds.
  const domain =
    kind === "software"
      ? software
      : kind === "finance"
        ? finance
        : kind === "kitchen"
          ? kitchen
          : kind === "trade"
            ? trade
            : software;
  const common: NavItem[] = [
    { label: "Assistant", href: `${v}/assistant`, icon: MessageSquareText },
    { label: "Chats", href: `${v}/whatsapp`, icon: MessageCircle },
    { label: "Invoices", href: `${v}/invoices`, icon: IndianRupee },
    { label: "Bookings", href: `${v}/bookings`, icon: CalendarCheck },
    { label: "Reviews", href: `${v}/reviews`, icon: Star },
    { label: "Automations", href: `${v}/automations`, icon: Repeat },
    { label: "Browser", href: `${v}/browser`, icon: Globe },
    { label: "Calls", href: `${v}/calls`, icon: PhoneCall },
    { label: "Analytics", href: `${v}/analytics`, icon: ChartColumn },
    { label: "Board", href: `${v}/board`, icon: LayoutDashboard },
    { label: "Agents", href: `${v}/agents`, icon: Bot },
    { label: "Runs", href: `${v}/runs`, icon: Activity },
    { label: "Knowledge", href: `${v}/knowledge`, icon: BookOpen },
    { label: "Mind map", href: `${v}/map`, icon: Network },
    { label: "Meetings", href: `${v}/meetings`, icon: Mic },
    { label: "Voice", href: `${v}/voice`, icon: AudioLines },
    { label: "Tasks", href: `${v}/tasks`, icon: ListChecks },
    { label: "Autonomy", href: `${v}/trust`, icon: Sparkles },
    { label: "Compliance", href: `${v}/compliance`, icon: ShieldCheck },
    { label: "Settings", href: `${v}/settings`, icon: Settings },
  ];
  return { domain, common };
}

export const topNav: NavItem[] = [
  { label: "Dashboard", href: "/", icon: Gauge },
  { label: "Inbox", href: "/inbox", icon: Inbox },
];

export const ownerNav: NavItem[] = [
  { label: "Businesses", href: "/businesses", icon: Building2 },
  { label: "Teams", href: "/teams", icon: UsersRound },
  { label: "Plan & billing", href: "/billing", icon: CreditCard },
  { label: "AI models", href: "/ai", icon: BrainCircuit },
  { label: "API keys", href: "/developers", icon: KeyRound },
  { label: "Single sign-on", href: "/sso", icon: LockKeyhole },
  { label: "Audit log", href: "/audit", icon: ScrollText },
];

export const staffNav: NavItem[] = [
  { label: "Pilot health", href: "/staff", icon: HeartPulse },
  { label: "Partners", href: "/staff/partners", icon: Handshake },
  { label: "Coupons", href: "/staff/coupons", icon: Gift },
];

export const accountNav: NavItem[] = [
  { label: "Your account", href: "/account", icon: CircleUser },
  { label: "Partner programme", href: "/partners", icon: Handshake },
  { label: "Help & contact", href: "/help", icon: LifeBuoy },
];

export const KIND_LABEL: Record<VentureKind, string> = {
  software: "Agency / services",
  finance: "Loans & real estate",
  kitchen: "Restaurant / kitchen",
  trade: "Export / import / C&F",
  general: "General",
};
