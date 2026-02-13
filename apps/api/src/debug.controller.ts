import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "./prisma/prisma.service";

@Controller("debug")
export class DebugController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("users")
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

