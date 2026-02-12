import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { ContactsController } from "./contacts.controller";
import { ContactsService } from "./contacts.service";

@Module({
  imports: [ActivityLogModule, AuthModule],
  controllers: [ContactsController],
  providers: [ContactsService],
  exports: [ContactsService]
})
export class ContactsModule {}
