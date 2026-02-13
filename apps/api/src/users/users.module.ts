import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

@Module({
  imports: [ActivityLogModule, AuthModule],
  controllers: [UsersController],
  providers: [UsersService]
})
export class UsersModule {}
