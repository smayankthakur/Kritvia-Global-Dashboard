"use client";

import { useRouter } from "next/navigation";
import { Role } from "../types/auth";

interface ModeSwitcherProps {
  role: Role;
}

const allowedModesByRole: Record<Role, Role[]> = {
  CEO: ["CEO"],
  OPS: ["OPS"],
  SALES: ["SALES"],
  FINANCE: ["FINANCE"],
  ADMIN: ["ADMIN", "CEO", "OPS", "SALES", "FINANCE"]
};

export function ModeSwitcher({ role }: ModeSwitcherProps) {
  const router = useRouter();
  const modes = allowedModesByRole[role];
  const routeByMode: Record<Role, string> = {
    CEO: "/ceo/dashboard",
    OPS: "/ops/work/board",
    SALES: "/sales/deals",
    FINANCE: "/finance/invoices",
    ADMIN: "/"
  };

  return (
    <div className="kv-mode-switcher">
      <select
        aria-label="Select mode"
        className="kv-topbar-select"
        defaultValue={role}
        onChange={(event) => router.push(routeByMode[event.target.value as Role])}
      >
        {modes.map((mode) => (
          <option key={mode} value={mode}>
            {mode}
          </option>
        ))}
      </select>
    </div>
  );
}
