import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { PaginationQueryDto } from "../common/dto/pagination-query.dto";
import { ConfirmFixActionRunDto } from "./dto/confirm-run.dto";
import { CreateFixActionRunDto } from "./dto/create-run.dto";
import { FixActionsService } from "./fix-actions.service";

@Controller("fix-actions")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CEO, Role.ADMIN, Role.OPS, Role.FINANCE, Role.SALES)
export class FixActionsController {
  constructor(private readonly fixActionsService: FixActionsService) {}

  @Get("templates")
  async listTemplates(@Req() req: { user: AuthUserContext }) {
    return this.fixActionsService.listTemplates(req.user);
  }

  @Post("runs")
  async createRun(
    @Req() req: { user: AuthUserContext },
    @Body() body: CreateFixActionRunDto
  ) {
    return this.fixActionsService.createRun(req.user, body);
  }

  @Post("runs/:id/confirm")
  async confirmRun(
    @Req() req: { user: AuthUserContext },
    @Param("id") id: string,
    @Body() body: ConfirmFixActionRunDto
  ) {
    return this.fixActionsService.confirmRun(req.user, id, body.confirm);
  }

  @Get("runs")
  async listRuns(
    @Req() req: { user: AuthUserContext },
    @Query() query: PaginationQueryDto,
    @Query("entityType") entityType?: string,
    @Query("entityId") entityId?: string,
    @Query("status") status?: string
  ) {
    return this.fixActionsService.listRuns(req.user, {
      entityType,
      entityId,
      status,
      page: query.page,
      pageSize: query.pageSize
    });
  }
}
