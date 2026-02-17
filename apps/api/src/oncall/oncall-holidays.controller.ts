import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import {
  CreateHolidayCalendarDto,
  CreateHolidayEntryDto,
  UpdateHolidayCalendarDto
} from "./dto/oncall.dto";
import { OnCallService } from "./oncall.service";

@Controller("org/holidays")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CEO, Role.ADMIN)
export class OnCallHolidaysController {
  constructor(private readonly onCallService: OnCallService) {}

  @Get("calendars")
  async listHolidayCalendars(@Req() req: { user: AuthUserContext }) {
    return this.onCallService.listHolidayCalendars(req.user);
  }

  @Post("calendars")
  async createHolidayCalendar(
    @Req() req: { user: AuthUserContext },
    @Body() dto: CreateHolidayCalendarDto
  ) {
    return this.onCallService.createHolidayCalendar(req.user, dto);
  }

  @Patch("calendars/:id")
  async updateHolidayCalendar(
    @Req() req: { user: AuthUserContext },
    @Param("id") id: string,
    @Body() dto: UpdateHolidayCalendarDto
  ) {
    return this.onCallService.updateHolidayCalendar(req.user, id, dto);
  }

  @Delete("calendars/:id")
  async removeHolidayCalendar(@Req() req: { user: AuthUserContext }, @Param("id") id: string) {
    return this.onCallService.removeHolidayCalendar(req.user, id);
  }

  @Get("calendars/:id/entries")
  async listHolidayEntries(@Req() req: { user: AuthUserContext }, @Param("id") id: string) {
    return this.onCallService.listHolidayEntries(req.user, id);
  }

  @Post("calendars/:id/entries")
  async createHolidayEntry(
    @Req() req: { user: AuthUserContext },
    @Param("id") id: string,
    @Body() dto: CreateHolidayEntryDto
  ) {
    return this.onCallService.createHolidayEntry(req.user, id, dto);
  }

  @Delete("entries/:id")
  async removeHolidayEntry(@Req() req: { user: AuthUserContext }, @Param("id") id: string) {
    return this.onCallService.removeHolidayEntry(req.user, id);
  }
}
