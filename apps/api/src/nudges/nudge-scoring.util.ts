import { NudgeSeverity, NudgeType } from "@prisma/client";

export interface NudgeScoreInput {
  type: NudgeType;
  now: Date;
  dueDate?: Date | null;
  amount?: number | null;
  dealValue?: number | null;
  updatedAt?: Date | null;
  criticalAmountThreshold?: number;
}

export interface NudgeScoreResult {
  severity: NudgeSeverity;
  priorityScore: number;
  meta: Record<string, number>;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function fullDaysBetween(now: Date, then: Date): number {
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / MS_PER_DAY));
}

export function computeNudgeScore(input: NudgeScoreInput): NudgeScoreResult {
  const threshold = input.criticalAmountThreshold ?? 50000;

  if (input.type === NudgeType.OVERDUE_INVOICE) {
    const daysOverdue = input.dueDate ? fullDaysBetween(input.now, input.dueDate) : 0;
    const amount = Math.max(0, input.amount ?? 0);
    const base = 30;
    const overdueBoost = Math.min(40, daysOverdue * 3);
    const amountBoost = Math.min(30, Math.round(Math.log10(amount + 1) * 10));
    const priorityScore = base + overdueBoost + amountBoost;
    const severity =
      daysOverdue >= 14 || amount >= threshold
        ? NudgeSeverity.CRITICAL
        : daysOverdue >= 7
          ? NudgeSeverity.HIGH
          : NudgeSeverity.MEDIUM;

    return {
      severity,
      priorityScore,
      meta: { daysOverdue, amount }
    };
  }

  if (input.type === NudgeType.OVERDUE_WORK) {
    const daysOverdue = input.dueDate ? fullDaysBetween(input.now, input.dueDate) : 0;
    const dealValue = Math.max(0, input.dealValue ?? 0);
    const base = 20;
    const overdueBoost = Math.min(50, daysOverdue * 4);
    const valueBoost = dealValue > 0 ? Math.min(30, Math.round(Math.log10(dealValue + 1) * 8)) : 0;
    const priorityScore = base + overdueBoost + valueBoost;
    const severity =
      daysOverdue >= 10 ? NudgeSeverity.CRITICAL : daysOverdue >= 5 ? NudgeSeverity.HIGH : NudgeSeverity.MEDIUM;

    return {
      severity,
      priorityScore,
      meta: { daysOverdue, dealValue }
    };
  }

  if (input.type === NudgeType.STALE_DEAL) {
    const idleDays = input.updatedAt ? fullDaysBetween(input.now, input.updatedAt) : 0;
    const base = 15;
    const idleBoost = Math.min(60, idleDays * 5);
    const priorityScore = base + idleBoost;
    const severity =
      idleDays >= 20 ? NudgeSeverity.CRITICAL : idleDays >= 10 ? NudgeSeverity.HIGH : NudgeSeverity.MEDIUM;

    return {
      severity,
      priorityScore,
      meta: { idleDays }
    };
  }

  return {
    severity: NudgeSeverity.MEDIUM,
    priorityScore: 10,
    meta: {}
  };
}
