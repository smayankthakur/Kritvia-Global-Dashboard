import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { ListAlertsQueryDto } from "./dto/list-alerts-query.dto";
import { UpdateAlertRuleDto } from "./dto/update-alert-rule.dto";
import {
  CreateAlertChannelDto,
  TestAlertChannelDto,
  UpdateAlertChannelDto
} from "./dto/alert-channel.dto";
import { TestEscalationPolicyDto, UpsertEscalationPolicyDto } from "./dto/escalation-policy.dto";
import { ListAlertDeliveriesQueryDto } from "./dto/list-alert-deliveries-query.dto";
import { AlertsService } from "./alerts.service";

@Controller("org")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CEO, Role.ADMIN)
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  @Get("alerts")
  async listAlerts(@Req() req: { user: AuthUserContext }, @Query() query: ListAlertsQueryDto) {
    return this.alertsService.listAlerts(req.user, query);
  }

  @Post("alerts/:id/acknowledge")
  async acknowledge(@Req() req: { user: AuthUserContext }, @Param("id") id: string) {
    return this.alertsService.acknowledge(req.user, id);
  }

  @Get("alert-rules")
  async listRules(@Req() req: { user: AuthUserContext }) {
    return this.alertsService.listRules(req.user);
  }

  @Patch("alert-rules/:id")
  async updateRule(
    @Req() req: { user: AuthUserContext },
    @Param("id") id: string,
    @Body() dto: UpdateAlertRuleDto
  ) {
    return this.alertsService.updateRule(req.user, id, dto);
  }

  @Get("alert-channels")
  async listChannels(@Req() req: { user: AuthUserContext }) {
    return this.alertsService.listChannels(req.user);
  }

  @Post("alert-channels")
  async createChannel(@Req() req: { user: AuthUserContext }, @Body() dto: CreateAlertChannelDto) {
    return this.alertsService.createChannel(req.user, dto);
  }

  @Patch("alert-channels/:id")
  async updateChannel(
    @Req() req: { user: AuthUserContext },
    @Param("id") id: string,
    @Body() dto: UpdateAlertChannelDto
  ) {
    return this.alertsService.updateChannel(req.user, id, dto);
  }

  @Post("alert-channels/:id/test")
  async testChannel(
    @Req() req: { user: AuthUserContext },
    @Param("id") id: string,
    @Body() dto: TestAlertChannelDto
  ) {
    return this.alertsService.testChannel(req.user, id, dto);
  }

  @Delete("alert-channels/:id")
  async deleteChannel(@Req() req: { user: AuthUserContext }, @Param("id") id: string) {
    return this.alertsService.deleteChannel(req.user, id);
  }

  @Get("alert-deliveries")
  async listDeliveries(
    @Req() req: { user: AuthUserContext },
    @Query() query: ListAlertDeliveriesQueryDto
  ) {
    return this.alertsService.listDeliveries(req.user, query);
  }

  @Get("escalation-policy")
  async getEscalationPolicy(@Req() req: { user: AuthUserContext }) {
    return this.alertsService.getEscalationPolicy(req.user);
  }

  @Post("escalation-policy")
  async createEscalationPolicy(
    @Req() req: { user: AuthUserContext },
    @Body() dto: UpsertEscalationPolicyDto
  ) {
    return this.alertsService.createEscalationPolicy(req.user, dto);
  }

  @Patch("escalation-policy/:id")
  async updateEscalationPolicy(
    @Req() req: { user: AuthUserContext },
    @Param("id") id: string,
    @Body() dto: UpsertEscalationPolicyDto
  ) {
    return this.alertsService.updateEscalationPolicy(req.user, id, dto);
  }

  @Get("alerts/:id/escalations")
  async listEscalationsForAlert(
    @Req() req: { user: AuthUserContext },
    @Param("id") id: string
  ) {
    return this.alertsService.listEscalationsForAlert(req.user, id);
  }

  @Post("escalation-policy/test")
  async testEscalationPolicy(
    @Req() req: { user: AuthUserContext },
    @Body() dto: TestEscalationPolicyDto
  ) {
    return this.alertsService.testEscalationPolicy(req.user, dto);
  }
}
