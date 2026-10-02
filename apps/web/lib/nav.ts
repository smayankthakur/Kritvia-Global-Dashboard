import {
  Activity,
  AudioLines,
  BookOpen,
  CalendarDays,
  ChefHat,
  ClipboardCheck,
  Database,
  FileText,
  Gauge,
  Inbox,
  Landmark,
  ListChecks,
  Mic,
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
  const domain =
    kind === "software"
      ? software
      : kind === "finance"
        ? finance
        : kind === "kitchen"
          ? kitchen
          : [...software, ...finance, ...kitchen];
  const common: NavItem[] = [
    { label: "Runs", href: `${v}/runs`, icon: Activity },
    { label: "Knowledge", href: `${v}/knowledge`, icon: BookOpen },
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

export const ownerNav: NavItem[] = [{ label: "Audit log", href: "/audit", icon: ScrollText }];

export const KIND_LABEL: Record<VentureKind, string> = {
  software: "Agency / services",
  finance: "Loans & real estate",
  kitchen: "Restaurant / kitchen",
  general: "General",
};
