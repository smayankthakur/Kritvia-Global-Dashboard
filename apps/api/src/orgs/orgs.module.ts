import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { OrgsController } from "./orgs.controller";
import { OrgsService } from "./orgs.service";

@Module({
  imports: [PrismaModule, AuthModule, ActivityLogModule],
  controllers: [OrgsController],
  providers: [OrgsService]
})
export class OrgsModule {}

