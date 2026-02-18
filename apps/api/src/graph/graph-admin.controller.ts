import { Body, Controller, Param, Post, Req, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { AuthUserContext } from "../auth/auth.types";
import { RolesGuard } from "../auth/roles.guard";
import { RepairRecentGraphDto } from "./dto/repair-recent-graph.dto";
import { GraphService } from "./graph.service";

@Controller("graph/repair")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CEO, Role.ADMIN)
export class GraphAdminController {
  constructor(private readonly graphService: GraphService) {}

  @Post("deal/:id")
  async repairDeal(@Req() req: { user: AuthUserContext }, @Param("id") id: string) {
    return this.graphService.repairDeal(req.user, id);
  }

  @Post("work-item/:id")
  async repairWorkItem(@Req() req: { user: AuthUserContext }, @Param("id") id: string) {
    return this.graphService.repairWorkItem(req.user, id);
  }

  @Post("invoice/:id")
  async repairInvoice(@Req() req: { user: AuthUserContext }, @Param("id") id: string) {
    return this.graphService.repairInvoice(req.user, id);
  }

  @Post("recent")
  async repairRecent(@Req() req: { user: AuthUserContext }, @Body() body: RepairRecentGraphDto) {
    return this.graphService.repairRecent(req.user, body);
  }
}
