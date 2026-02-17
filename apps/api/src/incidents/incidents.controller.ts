import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards
} from "@nestjs/common";
import { Role } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { IncidentMetricsQueryDto } from "./dto/incident-metrics-query.dto";
import { IncidentNoteDto } from "./dto/incident-note.dto";
import { ListIncidentsQueryDto } from "./dto/list-incidents-query.dto";
import { PublicIncidentUpdateDto } from "./dto/public-incident-update.dto";
import { PublishIncidentDto } from "./dto/publish-incident.dto";
import { UpdateIncidentSeverityDto } from "./dto/update-incident-severity.dto";
import { UpsertIncidentPostmortemDto } from "./dto/upsert-incident-postmortem.dto";
import { IncidentsService } from "./incidents.service";

@Controller("org/incidents")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CEO, Role.ADMIN, Role.OPS, Role.SALES, Role.FINANCE)
export class IncidentsController {
  constructor(private readonly incidentsService: IncidentsService) {}

  @Get()
  async listIncidents(@Req() req: { user: AuthUserContext }, @Query() query: ListIncidentsQueryDto) {
    return this.incidentsService.listIncidents(req.user, query);
  }

  @Get("metrics")
  @Roles(Role.CEO, Role.ADMIN)
  async getMetrics(@Req() req: { user: AuthUserContext }, @Query() query: IncidentMetricsQueryDto) {
    return this.incidentsService.getMetrics(req.user, query);
  }

  @Get(":id")
  async getIncident(@Req() req: { user: AuthUserContext }, @Param("id") id: string) {
    return this.incidentsService.getIncident(req.user, id);
  }

  @Post(":id/acknowledge")
  async acknowledgeIncident(@Req() req: { user: AuthUserContext }, @Param("id") id: string) {
    return this.incidentsService.acknowledgeIncident(req.user, id);
  }

  @Post(":id/resolve")
  async resolveIncident(@Req() req: { user: AuthUserContext }, @Param("id") id: string) {
    return this.incidentsService.resolveIncident(req.user, id);
  }

  @Patch(":id/severity")
  @Roles(Role.CEO, Role.ADMIN)
  async updateIncidentSeverity(
    @Req() req: { user: AuthUserContext },
    @Param("id") id: string,
    @Body() dto: UpdateIncidentSeverityDto
  ) {
    return this.incidentsService.updateIncidentSeverity(req.user, id, dto);
  }

  @Post(":id/notes")
  async addIncidentNote(
    @Req() req: { user: AuthUserContext },
    @Param("id") id: string,
    @Body() dto: IncidentNoteDto
  ) {
    return this.incidentsService.addIncidentNote(req.user, id, dto);
  }

  @Get(":id/postmortem")
  @Roles(Role.CEO, Role.ADMIN)
  async getPostmortem(@Req() req: { user: AuthUserContext }, @Param("id") id: string) {
    return this.incidentsService.getPostmortem(req.user, id);
  }

  @Post(":id/postmortem")
  @Roles(Role.CEO, Role.ADMIN)
  async upsertPostmortem(
    @Req() req: { user: AuthUserContext },
    @Param("id") id: string,
    @Body() dto: UpsertIncidentPostmortemDto
  ) {
    return this.incidentsService.upsertPostmortem(req.user, id, dto);
  }

  @Post(":id/publish")
  @Roles(Role.CEO, Role.ADMIN)
  async publishIncident(
    @Req() req: { user: AuthUserContext },
    @Param("id") id: string,
    @Body() dto: PublishIncidentDto
  ) {
    return this.incidentsService.publishIncident(req.user, id, dto);
  }

  @Post(":id/unpublish")
  @Roles(Role.CEO, Role.ADMIN)
  async unpublishIncident(@Req() req: { user: AuthUserContext }, @Param("id") id: string) {
    return this.incidentsService.unpublishIncident(req.user, id);
  }

  @Post(":id/public-update")
  @Roles(Role.CEO, Role.ADMIN)
  async addPublicUpdate(
    @Req() req: { user: AuthUserContext },
    @Param("id") id: string,
    @Body() dto: PublicIncidentUpdateDto
  ) {
    return this.incidentsService.addPublicUpdate(req.user, id, dto);
  }
}
