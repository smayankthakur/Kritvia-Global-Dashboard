import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AuthUserContext } from "../auth/auth.types";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { AcceptOrgInviteDto } from "./dto/accept-org-invite.dto";
import { InviteOrgMemberDto } from "./dto/invite-org-member.dto";
import { UpdateOrgMemberDto } from "./dto/update-org-member.dto";
import { OrgMembersService } from "./org-members.service";

@Controller("org")
export class OrgMembersController {
  constructor(private readonly orgMembersService: OrgMembersService) {}

  @Get("members")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CEO, Role.ADMIN)
  async list(@Req() req: { user: AuthUserContext }) {
    return this.orgMembersService.listMembers(req.user);
  }

  @Get("usage")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CEO, Role.ADMIN)
  async usage(@Req() req: { user: AuthUserContext }) {
    return this.orgMembersService.getUsage(req.user);
  }

  @Post("invite")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CEO, Role.ADMIN)
  async invite(@Req() req: { user: AuthUserContext }, @Body() dto: InviteOrgMemberDto) {
    return this.orgMembersService.invite(req.user, dto);
  }

  @Post("accept-invite")
  async acceptInvite(@Body() dto: AcceptOrgInviteDto) {
    return this.orgMembersService.acceptInvite(dto);
  }

  @Patch("members/:userId")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CEO, Role.ADMIN)
  async updateMember(
    @Req() req: { user: AuthUserContext },
    @Param("userId") userId: string,
    @Body() dto: UpdateOrgMemberDto
  ) {
    return this.orgMembersService.updateMember(req.user, userId, dto);
  }
}
