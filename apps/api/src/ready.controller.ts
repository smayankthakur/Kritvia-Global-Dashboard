import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "./prisma/prisma.service";

@Controller()
export class ReadyController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("ready")
  async getReady() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        status: "ok",
        service: "api",
        db: "ok",
        time: new Date().toISOString(),
        version: process.env.APP_VERSION ?? process.env.RENDER_GIT_COMMIT ?? "dev"
      };
    } catch {
      throw new ServiceUnavailableException("Service not ready.");
    }
  }
}
