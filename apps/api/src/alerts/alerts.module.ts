import { Module, forwardRef } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { BillingModule } from "../billing/billing.module";
import { IncidentsModule } from "../incidents/incidents.module";
import { JobsModule } from "../jobs/jobs.module";
import { OnCallModule } from "../oncall/oncall.module";
import { OauthModule } from "../oauth/oauth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AlertRoutingService } from "./alert-routing.service";
import { AlertsController } from "./alerts.controller";
import { AlertsService } from "./alerts.service";
import { AlertingService } from "./alerting.service";

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    BillingModule,
    IncidentsModule,
    ActivityLogModule,
    JobsModule,
    OnCallModule,
    forwardRef(() => OauthModule)
  ],
  controllers: [AlertsController],
  providers: [AlertsService, AlertingService, AlertRoutingService],
  exports: [AlertingService, AlertRoutingService]
})
export class AlertsModule {}
