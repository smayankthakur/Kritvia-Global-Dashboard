import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { ActivityLogModule } from "./activity-log/activity-log.module";
import { AuthModule } from "./auth/auth.module";
import { CompaniesModule } from "./companies/companies.module";
import { ContactsModule } from "./contacts/contacts.module";
import { DealsModule } from "./deals/deals.module";
import { DebugController } from "./debug.controller";
import { DirectoryModule } from "./directory/directory.module";
import { HealthController } from "./health.controller";
import { HealthScoreModule } from "./health-score/health-score.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { HygieneModule } from "./hygiene/hygiene.module";
import { InvoicesModule } from "./invoices/invoices.module";
import { JobsModule } from "./jobs/jobs.module";
import { LeadsModule } from "./leads/leads.module";
import { NudgesModule } from "./nudges/nudges.module";
import { PrismaModule } from "./prisma/prisma.module";
import { ReadyController } from "./ready.controller";
import { SecureController } from "./secure/secure.controller";
import { ShieldModule } from "./shield/shield.module";
import { SettingsModule } from "./settings/settings.module";
import { TimelineModule } from "./timeline/timeline.module";
import { UsersModule } from "./users/users.module";
import { WorkItemsModule } from "./work-items/work-items.module";

@Module({
  imports: [
    PrismaModule,
    ActivityLogModule,
    AuthModule,
    CompaniesModule,
    ContactsModule,
    DirectoryModule,
    LeadsModule,
    DealsModule,
    TimelineModule,
    ShieldModule,
    InvoicesModule,
    WorkItemsModule,
    JobsModule,
    DashboardModule,
    HealthScoreModule,
    HygieneModule,
    NudgesModule,
    UsersModule,
    SettingsModule,
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100
      }
    ])
  ],
  controllers: [HealthController, ReadyController, SecureController, DebugController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard
    }
  ]
})
export class AppModule {}
