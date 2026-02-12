import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AuthUserContext } from "../auth/auth.types";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { HygieneService } from "./hygiene.service";

@Controller("hygiene")
@UseGuards(JwtAuthGuard, RolesGuard)
export class HygieneController {
  constructor(private readonly hygieneService: HygieneService) {}

  @Get("inbox")
  @Roles(Role.OPS, Role.CEO, Role.ADMIN)
  async getInbox(@Req() req: { user: AuthUserContext }) {
    return this.hygieneService.getInbox(req.user);
  }
}
