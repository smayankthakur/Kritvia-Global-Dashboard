import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import {
  CreateOnCallMemberDto,
  CreateOnCallOverrideDto,
  CreateOnCallScheduleDto,
  LinkScheduleCalendarDto,
  UpdateOnCallMemberDto,
  UpdateOnCallScheduleDto
} from "./dto/oncall.dto";
import { OnCallService } from "./oncall.service";

@Controller("org/oncall")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CEO, Role.ADMIN)
export class OnCallController {
  constructor(private readonly onCallService: OnCallService) {}

  @Get("schedules")
  async listSchedules(@Req() req: { user: AuthUserContext }) {
    return this.onCallService.listSchedules(req.user);
  }

  @Post("schedules")
  async createSchedule(
    @Req() req: { user: AuthUserContext },
    @Body() dto: CreateOnCallScheduleDto
  ) {
    return this.onCallService.createSchedule(req.user, dto);
  }

  @Patch("schedules/:id")
  async updateSchedule(
    @Req() req: { user: AuthUserContext },
    @Param("id") id: string,
    @Body() dto: UpdateOnCallScheduleDto
  ) {
    return this.onCallService.updateSchedule(req.user, id, dto);
  }

  @Delete("schedules/:id")
  async removeSchedule(@Req() req: { user: AuthUserContext }, @Param("id") id: string) {
    return this.onCallService.removeSchedule(req.user, id);
  }

  @Get("schedules/:id/members")
  async listMembers(@Req() req: { user: AuthUserContext }, @Param("id") id: string) {
    return this.onCallService.listMembers(req.user, id);
  }

  @Post("schedules/:id/members")
  async createMember(
    @Req() req: { user: AuthUserContext },
    @Param("id") id: string,
    @Body() dto: CreateOnCallMemberDto
  ) {
    return this.onCallService.createMember(req.user, id, dto);
  }

  @Patch("members/:memberId")
  async updateMember(
    @Req() req: { user: AuthUserContext },
    @Param("memberId") memberId: string,
    @Body() dto: UpdateOnCallMemberDto
  ) {
    return this.onCallService.updateMember(req.user, memberId, dto);
  }

  @Delete("members/:memberId")
  async removeMember(
    @Req() req: { user: AuthUserContext },
    @Param("memberId") memberId: string
  ) {
    return this.onCallService.removeMember(req.user, memberId);
  }

  @Post("overrides")
  async createOverride(
    @Req() req: { user: AuthUserContext },
    @Body() dto: CreateOnCallOverrideDto
  ) {
    return this.onCallService.createOverride(req.user, dto);
  }

  @Get("overrides")
  async listOverrides(
    @Req() req: { user: AuthUserContext },
    @Query("scheduleId") scheduleId?: string
  ) {
    return this.onCallService.listOverrides(req.user, scheduleId);
  }

  @Delete("overrides/:id")
  async removeOverride(@Req() req: { user: AuthUserContext }, @Param("id") id: string) {
    return this.onCallService.removeOverride(req.user, id);
  }

  @Get("now")
  async getNow(@Req() req: { user: AuthUserContext }) {
    return this.onCallService.getNow(req.user);
  }

  @Post("schedules/:id/calendars")
  async linkScheduleCalendar(
    @Req() req: { user: AuthUserContext },
    @Param("id") id: string,
    @Body() dto: LinkScheduleCalendarDto
  ) {
    return this.onCallService.linkScheduleCalendar(req.user, id, dto);
  }

  @Delete("schedules/:id/calendars/:calendarId")
  async unlinkScheduleCalendar(
    @Req() req: { user: AuthUserContext },
    @Param("id") id: string,
    @Param("calendarId") calendarId: string
  ) {
    return this.onCallService.unlinkScheduleCalendar(req.user, id, calendarId);
  }
}
