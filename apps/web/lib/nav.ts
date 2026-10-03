import {
  Activity,
  AudioLines,
  BookOpen,
  Bot,
  CalendarDays,
  ChefHat,
  ClipboardCheck,
  Database,
  FileText,
  Gauge,
  LifeBuoy,
  CircleUser,
  CreditCard,
  Inbox,
  Landmark,
  ListChecks,
  Mic,
  Network,
  Receipt,
  ScrollText,
  Settings,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
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
  // A "general" business gets the leads screens (any business can run lead triage with a
  // rate card); the loan and kitchen screens only make sense for those kinds.
  const domain =
    kind === "software"
      ? software
      : kind === "finance"
        ? finance
        : kind === "kitchen"
          ? kitchen
          : software;
  const common: NavItem[] = [
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
  { label: "Plan & billing", href: "/billing", icon: CreditCard },
  { label: "Audit log", href: "/audit", icon: ScrollText },
];

export const accountNav: NavItem[] = [
  { label: "Your account", href: "/account", icon: CircleUser },
  { label: "Help & contact", href: "/help", icon: LifeBuoy },
];

export const KIND_LABEL: Record<VentureKind, string> = {
  software: "Agency / services",
  finance: "Loans & real estate",
  kitchen: "Restaurant / kitchen",
  general: "General",
};
