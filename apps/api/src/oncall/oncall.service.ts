import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ActivityEntityType } from "@prisma/client";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { AuthUserContext } from "../auth/auth.types";
import { BillingService } from "../billing/billing.service";
import { getActiveOrgId } from "../common/auth-org";
import { PrismaService } from "../prisma/prisma.service";
import { OnCallResolver } from "./oncall.resolver";
import {
  CreateHolidayCalendarDto,
  CreateHolidayEntryDto,
  CreateOnCallMemberDto,
  CreateOnCallOverrideDto,
  CreateOnCallScheduleDto,
  LinkScheduleCalendarDto,
  UpdateHolidayCalendarDto,
  UpdateOnCallMemberDto,
  UpdateOnCallScheduleDto
} from "./dto/oncall.dto";

@Injectable()
export class OnCallService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: BillingService,
    private readonly resolver: OnCallResolver,
    private readonly activityLogService: ActivityLogService
  ) {}

  async listSchedules(authUser: AuthUserContext) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");
    return this.prisma.onCallSchedule.findMany({
      where: { orgId },
      include: {
        calendars: {
          include: {
            calendar: {
              select: { id: true, name: true, timezone: true, isEnabled: true }
            }
          }
        }
      },
      orderBy: [{ createdAt: "desc" }]
    });
  }

  async createSchedule(authUser: AuthUserContext, dto: CreateOnCallScheduleDto) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

    const created = await this.prisma.onCallSchedule.create({
      data: {
        orgId,
        name: dto.name.trim(),
        timezone: dto.timezone?.trim() || "UTC",
        handoffInterval: dto.handoffInterval ?? "WEEKLY",
        handoffHour: dto.handoffHour ?? 10,
        startAt: dto.startAt ? new Date(dto.startAt) : new Date(),
        coverageEnabled: dto.coverageEnabled ?? false,
        coverageDays: dto.coverageDays ?? [],
        coverageStart: dto.coverageStart ?? null,
        coverageEnd: dto.coverageEnd ?? null,
        fallbackScheduleId: dto.fallbackScheduleId ?? null
      }
    });

    await this.activityLogService.log({
      orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.ALERT,
      entityId: created.id,
      action: "ONCALL_SCHEDULE_CREATED",
      after: created
    });

    return created;
  }

  async updateSchedule(authUser: AuthUserContext, id: string, dto: UpdateOnCallScheduleDto) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

    const existing = await this.prisma.onCallSchedule.findFirst({
      where: { id, orgId },
      select: { id: true }
    });

    if (!existing) {
      throw new NotFoundException("On-call schedule not found");
    }

    const updated = await this.prisma.onCallSchedule.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        timezone: dto.timezone?.trim(),
        handoffInterval: dto.handoffInterval,
        handoffHour: dto.handoffHour,
        isEnabled: dto.isEnabled,
        startAt: dto.startAt ? new Date(dto.startAt) : undefined,
        coverageEnabled: dto.coverageEnabled,
        coverageDays: dto.coverageDays,
        coverageStart: dto.coverageStart,
        coverageEnd: dto.coverageEnd,
        fallbackScheduleId:
          dto.fallbackScheduleId === undefined ? undefined : dto.fallbackScheduleId
      }
    });

    await this.activityLogService.log({
      orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.ALERT,
      entityId: updated.id,
      action: "ONCALL_SCHEDULE_UPDATED",
      after: updated
    });

    return updated;
  }

  async removeSchedule(authUser: AuthUserContext, id: string) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

    const updated = await this.prisma.onCallSchedule.updateMany({
      where: { id, orgId },
      data: { isEnabled: false }
    });

    if (updated.count === 0) {
      throw new NotFoundException("On-call schedule not found");
    }

    await this.activityLogService.log({
      orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.ALERT,
      entityId: id,
      action: "ONCALL_SCHEDULE_DISABLED"
    });

    return { success: true };
  }

  async listMembers(authUser: AuthUserContext, scheduleId: string) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");
    await this.assertScheduleOwnership(orgId, scheduleId);

    return this.prisma.onCallRotationMember.findMany({
      where: { scheduleId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true
          }
        }
      },
      orderBy: [{ tier: "asc" }, { order: "asc" }]
    });
  }

  async createMember(authUser: AuthUserContext, scheduleId: string, dto: CreateOnCallMemberDto) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");
    await this.assertScheduleOwnership(orgId, scheduleId);
    await this.assertUserInOrg(orgId, dto.userId);

    const created = await this.prisma.onCallRotationMember.create({
      data: {
        scheduleId,
        userId: dto.userId,
        tier: dto.tier,
        order: dto.order
      }
    });

    await this.activityLogService.log({
      orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.ALERT,
      entityId: created.id,
      action: "ONCALL_MEMBER_CREATED",
      after: created
    });

    return created;
  }

  async updateMember(authUser: AuthUserContext, memberId: string, dto: UpdateOnCallMemberDto) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

    const member = await this.prisma.onCallRotationMember.findFirst({
      where: {
        id: memberId,
        schedule: { orgId }
      },
      select: { id: true }
    });

    if (!member) {
      throw new NotFoundException("On-call member not found");
    }

    const updated = await this.prisma.onCallRotationMember.update({
      where: { id: memberId },
      data: {
        order: dto.order,
        isActive: dto.isActive
      }
    });

    await this.activityLogService.log({
      orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.ALERT,
      entityId: updated.id,
      action: "ONCALL_MEMBER_UPDATED",
      after: updated
    });

    return updated;
  }

  async removeMember(authUser: AuthUserContext, memberId: string) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

    const deleted = await this.prisma.onCallRotationMember.deleteMany({
      where: {
        id: memberId,
        schedule: { orgId }
      }
    });

    if (deleted.count === 0) {
      throw new NotFoundException("On-call member not found");
    }

    await this.activityLogService.log({
      orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.ALERT,
      entityId: memberId,
      action: "ONCALL_MEMBER_REMOVED"
    });

    return { success: true };
  }

  async createOverride(authUser: AuthUserContext, dto: CreateOnCallOverrideDto) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");
    await this.assertScheduleOwnership(orgId, dto.scheduleId);
    await this.assertUserInOrg(orgId, dto.toUserId);
    if (dto.fromUserId) {
      await this.assertUserInOrg(orgId, dto.fromUserId);
    }

    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    if (endAt <= startAt) {
      throw new BadRequestException("Override endAt must be after startAt");
    }

    const created = await this.prisma.onCallOverride.create({
      data: {
        scheduleId: dto.scheduleId,
        tier: dto.tier,
        fromUserId: dto.fromUserId,
        toUserId: dto.toUserId,
        startAt,
        endAt,
        reason: dto.reason?.trim() || null
      }
    });

    await this.activityLogService.log({
      orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.ALERT,
      entityId: created.id,
      action: "ONCALL_OVERRIDE_CREATED",
      after: created
    });

    return created;
  }

  async listOverrides(authUser: AuthUserContext, scheduleId?: string) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

    return this.prisma.onCallOverride.findMany({
      where: {
        schedule: { orgId },
        ...(scheduleId ? { scheduleId } : {})
      },
      include: {
        toUser: {
          select: {
            id: true,
            name: true,
            email: true
          }
        },
        fromUser: {
          select: {
            id: true,
            name: true,
            email: true
          }
        }
      },
      orderBy: [{ startAt: "desc" }]
    });
  }

  async removeOverride(authUser: AuthUserContext, id: string) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

    const deleted = await this.prisma.onCallOverride.deleteMany({
      where: {
        id,
        schedule: { orgId }
      }
    });

    if (deleted.count === 0) {
      throw new NotFoundException("On-call override not found");
    }

    await this.activityLogService.log({
      orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.ALERT,
      entityId: id,
      action: "ONCALL_OVERRIDE_REMOVED"
    });

    return { success: true };
  }

  async getNow(authUser: AuthUserContext) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

    const resolved = await this.resolver.resolveNow(orgId);

    const users = await this.prisma.user.findMany({
      where: {
        id: {
          in: [resolved.primaryUserId, resolved.secondaryUserId].filter(
            (entry): entry is string => Boolean(entry)
          )
        }
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true
      }
    });

    const userMap = new Map(users.map((entry) => [entry.id, entry]));

    return {
      scheduleId: resolved.scheduleId,
      activeScheduleId: resolved.activeScheduleId ?? resolved.scheduleId,
      inCoverageWindow: resolved.inCoverageWindow ?? false,
      isHoliday: resolved.isHoliday ?? false,
      primary: resolved.primaryUserId ? userMap.get(resolved.primaryUserId) ?? null : null,
      secondary: resolved.secondaryUserId ? userMap.get(resolved.secondaryUserId) ?? null : null
    };
  }

  async listHolidayCalendars(authUser: AuthUserContext) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");
    return this.prisma.holidayCalendar.findMany({
      where: { orgId },
      orderBy: [{ createdAt: "desc" }]
    });
  }

  async createHolidayCalendar(authUser: AuthUserContext, dto: CreateHolidayCalendarDto) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");
    const created = await this.prisma.holidayCalendar.create({
      data: {
        orgId,
        name: dto.name.trim(),
        timezone: dto.timezone?.trim() || "UTC"
      }
    });
    await this.activityLogService.log({
      orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.ALERT,
      entityId: created.id,
      action: "HOLIDAY_CALENDAR_CREATED",
      after: created
    });
    return created;
  }

  async updateHolidayCalendar(authUser: AuthUserContext, id: string, dto: UpdateHolidayCalendarDto) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");
    const existing = await this.prisma.holidayCalendar.findFirst({
      where: { id, orgId },
      select: { id: true }
    });
    if (!existing) {
      throw new NotFoundException("Holiday calendar not found");
    }
    return this.prisma.holidayCalendar.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        timezone: dto.timezone?.trim(),
        isEnabled: dto.isEnabled
      }
    });
  }

  async removeHolidayCalendar(authUser: AuthUserContext, id: string) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");
    const updated = await this.prisma.holidayCalendar.updateMany({
      where: { id, orgId },
      data: { isEnabled: false }
    });
    if (updated.count === 0) {
      throw new NotFoundException("Holiday calendar not found");
    }
    return { success: true };
  }

  async listHolidayEntries(authUser: AuthUserContext, calendarId: string) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");
    await this.assertCalendarOwnership(orgId, calendarId);
    return this.prisma.holidayEntry.findMany({
      where: { calendarId },
      orderBy: [{ startDate: "asc" }]
    });
  }

  async createHolidayEntry(authUser: AuthUserContext, calendarId: string, dto: CreateHolidayEntryDto) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");
    await this.assertCalendarOwnership(orgId, calendarId);

    const startDate = this.toDateOnly(dto.startDate);
    const endDate = dto.endDate ? this.toDateOnly(dto.endDate) : null;
    if (endDate && endDate < startDate) {
      throw new BadRequestException("Holiday endDate must be on or after startDate");
    }

    return this.prisma.holidayEntry.create({
      data: {
        calendarId,
        startDate,
        endDate,
        title: dto.title?.trim() || null
      }
    });
  }

  async removeHolidayEntry(authUser: AuthUserContext, id: string) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");
    const deleted = await this.prisma.holidayEntry.deleteMany({
      where: {
        id,
        calendar: { orgId }
      }
    });
    if (deleted.count === 0) {
      throw new NotFoundException("Holiday entry not found");
    }
    return { success: true };
  }

  async linkScheduleCalendar(
    authUser: AuthUserContext,
    scheduleId: string,
    dto: LinkScheduleCalendarDto
  ) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");
    await this.assertScheduleOwnership(orgId, scheduleId);
    await this.assertCalendarOwnership(orgId, dto.calendarId);

    return this.prisma.onCallScheduleCalendar.upsert({
      where: {
        scheduleId_calendarId: {
          scheduleId,
          calendarId: dto.calendarId
        }
      },
      update: {},
      create: {
        scheduleId,
        calendarId: dto.calendarId
      }
    });
  }

  async unlinkScheduleCalendar(authUser: AuthUserContext, scheduleId: string, calendarId: string) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");
    await this.assertScheduleOwnership(orgId, scheduleId);
    const deleted = await this.prisma.onCallScheduleCalendar.deleteMany({
      where: {
        scheduleId,
        calendarId,
        schedule: { orgId }
      }
    });
    if (deleted.count === 0) {
      throw new NotFoundException("Schedule calendar link not found");
    }
    return { success: true };
  }

  private async assertScheduleOwnership(orgId: string, scheduleId: string): Promise<void> {
    const exists = await this.prisma.onCallSchedule.findFirst({
      where: {
        id: scheduleId,
        orgId
      },
      select: { id: true }
    });

    if (!exists) {
      throw new NotFoundException("On-call schedule not found");
    }
  }

  private async assertUserInOrg(orgId: string, userId: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        orgId,
        isActive: true
      },
      select: { id: true }
    });

    if (!user) {
      throw new BadRequestException("User must be active in this org");
    }
  }

  private async assertCalendarOwnership(orgId: string, calendarId: string): Promise<void> {
    const exists = await this.prisma.holidayCalendar.findFirst({
      where: { id: calendarId, orgId },
      select: { id: true }
    });
    if (!exists) {
      throw new NotFoundException("Holiday calendar not found");
    }
  }

  private toDateOnly(value: string): Date {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException("Invalid date value");
    }
    return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
  }
}
