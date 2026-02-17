import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export type OnCallResolvedNow = {
  scheduleId: string | null;
  primaryUserId: string | null;
  secondaryUserId: string | null;
  activeScheduleId?: string | null;
  inCoverageWindow?: boolean;
  isHoliday?: boolean;
};

type RotationTier = "PRIMARY" | "SECONDARY";

type ResolveOptions = {
  forceFallback?: boolean;
};

type ResolvedSchedule = {
  scheduleId: string;
  primaryUserId: string | null;
  secondaryUserId: string | null;
  inCoverageWindow: boolean;
  isHoliday: boolean;
};

@Injectable()
export class OnCallResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolveNow(
    orgId: string,
    now: Date = new Date(),
    options?: ResolveOptions
  ): Promise<OnCallResolvedNow> {
    const schedules = await this.prisma.onCallSchedule.findMany({
      where: {
        orgId,
        isEnabled: true
      },
      include: {
        members: {
          where: { isActive: true },
          orderBy: [{ tier: "asc" }, { order: "asc" }]
        },
        overrides: {
          where: {
            startAt: { lte: now },
            endAt: { gte: now }
          },
          orderBy: [{ createdAt: "desc" }]
        },
        calendars: {
          include: {
            calendar: {
              include: {
                entries: true
              }
            }
          }
        }
      },
      orderBy: [{ createdAt: "asc" }]
    });

    if (schedules.length === 0) {
      return {
        scheduleId: null,
        activeScheduleId: null,
        primaryUserId: null,
        secondaryUserId: null,
        inCoverageWindow: false,
        isHoliday: false
      };
    }

    const scheduleMap = new Map(schedules.map((entry) => [entry.id, entry]));

    if (options?.forceFallback) {
      const fallbackResolved = this.resolveFallbackChain(schedules, scheduleMap, now);
      if (fallbackResolved) {
        return fallbackResolved;
      }
    }

    for (const schedule of schedules) {
      const state = this.getScheduleState(schedule, now);
      if (!state.active) {
        continue;
      }
      return this.resolveSchedule(schedule, state, now);
    }

    const fallbackResolved = this.resolveFallbackChain(schedules, scheduleMap, now);
    if (fallbackResolved) {
      return fallbackResolved;
    }

    return {
      scheduleId: null,
      activeScheduleId: null,
      primaryUserId: null,
      secondaryUserId: null,
      inCoverageWindow: false,
      isHoliday: false
    };
  }

  private resolveFallbackChain(
    schedules: Array<{
      id: string;
      fallbackScheduleId: string | null;
      members: Array<{ tier: string; userId: string }>;
      overrides: Array<{ tier: string; toUserId: string }>;
      startAt: Date;
      handoffInterval: string;
      handoffHour: number;
      timezone: string;
      coverageEnabled: boolean;
      coverageDays: unknown;
      coverageStart: string | null;
      coverageEnd: string | null;
      calendars: Array<{
        calendar: {
          timezone: string;
          isEnabled: boolean;
          entries: Array<{ startDate: Date; endDate: Date | null }>;
        };
      }>;
    }>,
    scheduleMap: Map<string, (typeof schedules)[number]>,
    now: Date
  ): OnCallResolvedNow | null {
    const visited = new Set<string>();
    const roots = schedules.filter((entry) => Boolean(entry.fallbackScheduleId));

    for (const root of roots) {
      let nextId = root.fallbackScheduleId;
      while (nextId && !visited.has(nextId)) {
        visited.add(nextId);
        const fallback = scheduleMap.get(nextId);
        if (!fallback) {
          break;
        }

        const state = this.getScheduleState(fallback, now);
        if (state.active) {
          return this.resolveSchedule(fallback, state, now);
        }

        nextId = fallback.fallbackScheduleId;
      }
    }

    return null;
  }

  private resolveSchedule(
    schedule: {
      id: string;
      members: Array<{ tier: string; userId: string }>;
      overrides: Array<{ tier: string; toUserId: string }>;
      startAt: Date;
      handoffInterval: string;
      handoffHour: number;
      timezone: string;
    },
    state: { inCoverageWindow: boolean; isHoliday: boolean },
    now: Date
  ): OnCallResolvedNow {
    const slotIndex = this.computeSlotIndex(
      schedule.startAt,
      now,
      schedule.handoffInterval,
      schedule.handoffHour,
      schedule.timezone
    );

    const primaryUserId = this.pickUserForTier(schedule.members, "PRIMARY", slotIndex);
    const secondaryUserId = this.pickUserForTier(schedule.members, "SECONDARY", slotIndex);

    const primaryOverride = schedule.overrides.find((entry) => entry.tier === "PRIMARY");
    const secondaryOverride = schedule.overrides.find((entry) => entry.tier === "SECONDARY");

    return {
      scheduleId: schedule.id,
      activeScheduleId: schedule.id,
      primaryUserId: primaryOverride?.toUserId ?? primaryUserId,
      secondaryUserId: secondaryOverride?.toUserId ?? secondaryUserId,
      inCoverageWindow: state.inCoverageWindow,
      isHoliday: state.isHoliday
    };
  }

  private getScheduleState(
    schedule: {
      coverageEnabled: boolean;
      coverageDays: unknown;
      coverageStart: string | null;
      coverageEnd: string | null;
      timezone: string;
      calendars: Array<{
        calendar: {
          timezone: string;
          isEnabled: boolean;
          entries: Array<{ startDate: Date; endDate: Date | null }>;
        };
      }>;
    },
    now: Date
  ): { active: boolean; inCoverageWindow: boolean; isHoliday: boolean } {
    const inCoverageWindow = this.isInCoverageWindow(schedule, now);
    const isHoliday = this.isHoliday(schedule, now);
    return {
      active: inCoverageWindow && !isHoliday,
      inCoverageWindow,
      isHoliday
    };
  }

  private isInCoverageWindow(
    schedule: {
      coverageEnabled: boolean;
      coverageDays: unknown;
      coverageStart: string | null;
      coverageEnd: string | null;
      timezone: string;
    },
    now: Date
  ): boolean {
    if (!schedule.coverageEnabled) {
      return true;
    }

    const local = this.getLocalTime(now, schedule.timezone || "UTC");
    const days = this.normalizeCoverageDays(schedule.coverageDays);
    if (days.length > 0 && !days.includes(local.weekday)) {
      return false;
    }

    const startMinutes = this.parseMinutes(schedule.coverageStart);
    const endMinutes = this.parseMinutes(schedule.coverageEnd);
    if (startMinutes === null || endMinutes === null) {
      return true;
    }

    if (startMinutes === endMinutes) {
      return true;
    }
    if (startMinutes < endMinutes) {
      return local.minutesOfDay >= startMinutes && local.minutesOfDay < endMinutes;
    }
    return local.minutesOfDay >= startMinutes || local.minutesOfDay < endMinutes;
  }

  private isHoliday(
    schedule: {
      calendars: Array<{
        calendar: {
          timezone: string;
          isEnabled: boolean;
          entries: Array<{ startDate: Date; endDate: Date | null }>;
        };
      }>;
    },
    now: Date
  ): boolean {
    for (const linked of schedule.calendars) {
      const calendar = linked.calendar;
      if (!calendar.isEnabled) {
        continue;
      }
      const today = this.formatDateInTimezone(now, calendar.timezone || "UTC");
      for (const entry of calendar.entries) {
        const start = this.formatDateInTimezone(entry.startDate, calendar.timezone || "UTC");
        const end = this.formatDateInTimezone(entry.endDate ?? entry.startDate, calendar.timezone || "UTC");
        if (today >= start && today <= end) {
          return true;
        }
      }
    }
    return false;
  }

  private normalizeCoverageDays(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const allowed = new Set(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);
    return value
      .map((entry) => String(entry).trim().toUpperCase())
      .filter((entry) => allowed.has(entry));
  }

  private getLocalTime(now: Date, timezone: string): { weekday: string; minutesOfDay: number } {
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      });
      const parts = formatter.formatToParts(now);
      const weekdayRaw = parts.find((part) => part.type === "weekday")?.value ?? "Mon";
      const weekday = this.shortWeekdayToCode(weekdayRaw);
      const hour = Number.parseInt(parts.find((part) => part.type === "hour")?.value ?? "0", 10);
      const minute = Number.parseInt(parts.find((part) => part.type === "minute")?.value ?? "0", 10);
      return { weekday, minutesOfDay: hour * 60 + minute };
    } catch {
      const utcWeekday = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][now.getUTCDay()] ?? "MON";
      return { weekday: utcWeekday, minutesOfDay: now.getUTCHours() * 60 + now.getUTCMinutes() };
    }
  }

  private shortWeekdayToCode(value: string): string {
    const normalized = value.slice(0, 3).toUpperCase();
    if (normalized === "MON") return "MON";
    if (normalized === "TUE") return "TUE";
    if (normalized === "WED") return "WED";
    if (normalized === "THU") return "THU";
    if (normalized === "FRI") return "FRI";
    if (normalized === "SAT") return "SAT";
    return "SUN";
  }

  private formatDateInTimezone(value: Date, timezone: string): string {
    try {
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      });
      const parts = formatter.formatToParts(value);
      const year = parts.find((part) => part.type === "year")?.value ?? "1970";
      const month = parts.find((part) => part.type === "month")?.value ?? "01";
      const day = parts.find((part) => part.type === "day")?.value ?? "01";
      return `${year}-${month}-${day}`;
    } catch {
      return value.toISOString().slice(0, 10);
    }
  }

  private parseMinutes(value: string | null): number | null {
    if (!value) {
      return null;
    }
    const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
    if (!match) {
      return null;
    }
    const hours = Number.parseInt(match[1], 10);
    const minutes = Number.parseInt(match[2], 10);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      return null;
    }
    return hours * 60 + minutes;
  }

  private pickUserForTier(
    members: Array<{ tier: string; userId: string }>,
    tier: RotationTier,
    slotIndex: number
  ): string | null {
    const tierMembers = members.filter((entry) => entry.tier === tier);
    if (tierMembers.length === 0) {
      return null;
    }
    const normalizedIndex = ((slotIndex % tierMembers.length) + tierMembers.length) % tierMembers.length;
    return tierMembers[normalizedIndex].userId;
  }

  private computeSlotIndex(
    startAt: Date,
    now: Date,
    interval: string,
    handoffHour: number,
    timezone: string
  ): number {
    const startLocal = this.toPseudoLocalTimestamp(startAt, timezone, handoffHour);
    const nowLocal = this.toPseudoLocalTimestamp(now, timezone, handoffHour);
    const elapsedMs = Math.max(0, nowLocal - startLocal);
    const windowMs = interval === "DAILY" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    return Math.floor(elapsedMs / windowMs);
  }

  private toPseudoLocalTimestamp(value: Date, timezone: string, handoffHour: number): number {
    try {
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone || "UTC",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
      });

      const parts = formatter.formatToParts(value);
      const year = parts.find((part) => part.type === "year")?.value ?? "1970";
      const month = parts.find((part) => part.type === "month")?.value ?? "01";
      const day = parts.find((part) => part.type === "day")?.value ?? "01";
      const hour = Number.parseInt(parts.find((part) => part.type === "hour")?.value ?? "0", 10);
      const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
      const second = parts.find((part) => part.type === "second")?.value ?? "00";

      const adjustedHour = ((hour - handoffHour) + 24) % 24;
      const localIso = `${year}-${month}-${day}T${String(adjustedHour).padStart(2, "0")}:${minute}:${second}.000Z`;
      return new Date(localIso).getTime();
    } catch {
      const adjusted = new Date(value);
      adjusted.setUTCHours(
        adjusted.getUTCHours() - handoffHour,
        adjusted.getUTCMinutes(),
        adjusted.getUTCSeconds(),
        adjusted.getUTCMilliseconds()
      );
      return adjusted.getTime();
    }
  }
}
