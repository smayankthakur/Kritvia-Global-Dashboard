import { Controller, Get, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";

@Controller("secure")
@UseGuards(JwtAuthGuard, RolesGuard)
export class SecureController {
  @Get("admin-only")
  @Roles(Role.ADMIN)
  adminOnly(): { message: string } {
    return { message: "admin access granted" };
  }

  @Get("finance-only")
  @Roles(Role.FINANCE, Role.ADMIN)
  financeOnly(): { message: string } {
    return { message: "finance access granted" };
  }
}
