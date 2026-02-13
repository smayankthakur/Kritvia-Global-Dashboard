import { Controller, Get, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { Roles } from "./auth/roles.decorator";
import { RolesGuard } from "./auth/roles.guard";
import { PrismaService } from "./prisma/prisma.service";

@Controller("debug")
export class DebugController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("users")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  async listUsers(): Promise<{ count: number; users: Array<{ email: string }> }> {
    const users = await this.prisma.user.findMany({
      select: { email: true },
      orderBy: { createdAt: "asc" }
    });

    return {
      count: users.length,
      users
    };
  }
}
