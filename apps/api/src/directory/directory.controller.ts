import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AuthUserContext } from "../auth/auth.types";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { DirectoryService } from "./directory.service";

@Controller("directory")
@UseGuards(JwtAuthGuard, RolesGuard)
export class DirectoryController {
  constructor(private readonly directoryService: DirectoryService) {}

  @Get("users")
  @Roles(Role.ADMIN, Role.CEO, Role.OPS)
  async listUsers(@Req() req: { user: AuthUserContext }) {
    return this.directoryService.listUsers(req.user);
  }
}

