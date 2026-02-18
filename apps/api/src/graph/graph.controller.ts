import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { AuthUserContext } from "../auth/auth.types";
import { RolesGuard } from "../auth/roles.guard";
import { GraphService } from "./graph.service";
import { ListGraphDto } from "./dto/list-graph.dto";
import { TraverseGraphDto } from "./dto/traverse-graph.dto";

@Controller("graph")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CEO, Role.ADMIN, Role.OPS, Role.SALES, Role.FINANCE)
export class GraphController {
  constructor(private readonly graphService: GraphService) {}

  @Get("nodes")
  async listNodes(@Req() req: { user: AuthUserContext }, @Query() query: ListGraphDto) {
    return this.graphService.listNodes(req.user, query);
  }

  @Get("edges")
  async listEdges(@Req() req: { user: AuthUserContext }, @Query() query: ListGraphDto) {
    return this.graphService.listEdges(req.user, query);
  }

  @Get("node/:id")
  async getNode(@Req() req: { user: AuthUserContext }, @Param("id") id: string) {
    return this.graphService.getNode(req.user, id);
  }

  @Post("traverse")
  async traverse(@Req() req: { user: AuthUserContext }, @Body() body: TraverseGraphDto) {
    return this.graphService.traverse(req.user, body);
  }
}
