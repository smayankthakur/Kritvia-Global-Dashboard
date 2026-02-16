import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { BillingModule } from "../billing/billing.module";
import { PrismaModule } from "../prisma/prisma.module";
import { QueueModule } from "../queue/queue.module";
import { LlmController } from "./llm.controller";
import { LlmService } from "./llm.service";
import { GenericHttpLlmProvider } from "./providers/generic-http.provider";
import { MockLlmProvider } from "./providers/mock.provider";

@Module({
  imports: [PrismaModule, BillingModule, AuthModule, ActivityLogModule, QueueModule],
  controllers: [LlmController],
  providers: [LlmService, MockLlmProvider, GenericHttpLlmProvider]
})
export class LlmModule {}
