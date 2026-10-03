"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, Crown, PauseCircle, Pencil, Wallet } from "lucide-react";
import { motion, useReducedMotion, type Variants } from "motion/react";
import { useState } from "react";
import { workflowLabel } from "@/components/runs/run-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap } from "@/lib/api";
import {
  ROLE_BLURBS,
  ROLE_ORDER,
  ROLE_TITLES,
  formatSpend,
  formatTokens,
  groupRoles,
  parseTokens,
  type Board,
  type Role,
  type RoleKey,
} from "@/lib/board";
import { SpendMeter } from "./spend-meter";

const stagger: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.06, delayChildren: 0.05 } } };
const rise: Variants = { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 260, damping: 24 } } };

/** You at the top; four roles beneath, each holding its agents with this month's spend. */
export function OrgChart({
  ventureId,
  board,
  ownerName,
  canAdmin,
}: {
  ventureId: string;
  board: Board;
  ownerName: string;
  canAdmin: boolean;
}) {
  const reduce = useReducedMotion();
  const groups = groupRoles(board.roles);
  const [editing, setEditing] = useState<Role | null>(null);
  return (
    <section aria-label="Org chart" className="relative">
      <motion.div
        className="mx-auto mb-3 flex w-fit items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-sm shadow-card"
        initial={reduce ? false : { opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <Crown className="h-4 w-4 text-accent" aria-hidden />
        <span className="font-medium text-fg">{ownerName}</span>
        <span className="text-subtle">· {formatSpend(board.month_cost_usd)} this month · {formatTokens(board.month_tokens)} tokens</span>
      </motion.div>
      <div aria-hidden className="mx-auto mb-3 h-4 w-px bg-border-strong" />
      <motion.ul
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
        variants={reduce ? undefined : stagger}
        initial={reduce ? false : "hidden"}
        animate="show"
      >
        {groups.map(({ key, agents }) => (
          <motion.li key={key} variants={reduce ? undefined : rise} className="min-w-0">
            <RoleCard
              role={key}
              agents={agents}
              canAdmin={canAdmin}
              budgetsEditable={board.budgets_editable}
              onEdit={setEditing}
            />
          </motion.li>
        ))}
      </motion.ul>
      {editing ? (
        <AgentDialog
          ventureId={ventureId}
          role={editing}
          budgetsEditable={board.budgets_editable}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}

function RoleCard({
  role,
  agents,
  canAdmin,
  budgetsEditable,
  onEdit,
}: {
  role: RoleKey;
  agents: Role[];
  canAdmin: boolean;
  budgetsEditable: boolean;
  onEdit: (r: Role) => void;
}) {
  const working = agents.reduce((n, a) => n + a.open_tickets, 0);
  const waiting = agents.reduce((n, a) => n + a.waiting, 0);
  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-surface shadow-card">
      <div className="flex items-start justify-between gap-2 border-b border-border px-3.5 py-2.5">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-fg">{ROLE_TITLES[role]}</h3>
          <p className="text-xs text-subtle">{ROLE_BLURBS[role]}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {waiting > 0 ? (
            <Badge tone="warning" dot title="Drafts waiting for you">
              {waiting}
            </Badge>
          ) : null}
          {working > 0 ? (
            <Badge tone="info" title="Runs in progress">
              <WorkingDot /> {working}
            </Badge>
          ) : null}
        </div>
      </div>
      <ul className="flex flex-1 flex-col divide-y divide-border">
        {agents.length === 0 ? (
          <li className="px-3.5 py-4 text-xs text-subtle">No agent here yet. Switch one on under Agents.</li>
        ) : (
          agents.map((a) => (
            <li key={a.workflow} className={cn("px-3.5 py-3", !a.enabled && "opacity-60")}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-soft-fg">
                    <Bot className="h-3.5 w-3.5" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg">{workflowLabel(a.workflow)}</p>
                    <p className="truncate text-[11.5px] text-subtle">
                      {a.paused ? (
                        <span className="inline-flex items-center gap-1 text-danger-fg">
                          <PauseCircle className="h-3 w-3" aria-hidden /> Paused: budget used
                        </span>
                      ) : !a.enabled ? (
                        "Switched off"
                      ) : (
                        `${formatSpend(a.cost_usd)} this month`
                      )}
                    </p>
                  </div>
                </div>
                {canAdmin ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0"
                    aria-label={`Edit ${workflowLabel(a.workflow)}: role and budget`}
                    onClick={() => onEdit(a)}
                    icon={budgetsEditable ? <Wallet className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
                  />
                ) : null}
              </div>
              <SpendMeter role={a} compact />
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

/** A soft pulse: the agent is doing something right now. */
export function WorkingDot({ className }: { className?: string }) {
  const reduce = useReducedMotion();
  return (
    <span className={cn("relative inline-flex h-2 w-2", className)} aria-hidden>
      {!reduce ? (
        <motion.span
          className="absolute inline-flex h-full w-full rounded-full bg-current opacity-60"
          animate={{ scale: [1, 2.2], opacity: [0.6, 0] }}
          transition={{ repeat: Infinity, duration: 1.6, ease: "easeOut" }}
        />
      ) : null}
      <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
    </span>
  );
}

function AgentDialog({
  ventureId,
  role,
  budgetsEditable,
  onClose,
}: {
  ventureId: string;
  role: Role;
  budgetsEditable: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [place, setPlace] = useState<RoleKey>(role.role as RoleKey);
  const [budget, setBudget] = useState(role.monthly_tokens == null ? "" : formatTokens(role.monthly_tokens));
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const trimmed = budget.trim();
      const tokens = trimmed === "" ? null : parseTokens(trimmed);
      if (trimmed !== "" && tokens == null) throw new Error("Budget looks wrong. Try 500k or 2M.");
      return unwrap(
        api.PUT("/ventures/{venture_id}/board/agents/{workflow}", {
          params: { path: { venture_id: ventureId, workflow: role.workflow } },
          body: {
            role: place,
            clear_budget: budgetsEditable && tokens == null,
            monthly_tokens: budgetsEditable && tokens != null ? tokens : null,
          },
        }),
      );
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["board", ventureId] });
      toast.success(`${workflowLabel(r.workflow)} updated`, r.monthly_tokens == null ? "No cap beyond your plan." : `Capped at ${formatTokens(r.monthly_tokens)} tokens a month.`);
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={workflowLabel(role.workflow)}
      description="Where this agent sits on your board and how much AI it may use each month."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Role">
          <Select value={place} onChange={(e) => setPlace(e.target.value as RoleKey)}>
            {ROLE_ORDER.map((k) => (
              <option key={k} value={k}>
                {ROLE_TITLES[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Monthly budget (tokens)"
          hint={
            budgetsEditable
              ? `Used ${formatTokens(role.used_tokens)} so far this month. Leave empty for no cap; 0 pauses the agent.`
              : "Per-agent budgets come with the Starter plan."
          }
          error={error}
        >
          <Input
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="e.g. 500k"
            inputMode="text"
            disabled={!budgetsEditable}
          />
        </Field>
      </div>
    </Dialog>
  );
}
