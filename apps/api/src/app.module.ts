import { MiddlewareConsumer, Module, NestModule, RequestMethod } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { ActivityLogModule } from "./activity-log/activity-log.module";
import { AlertsModule } from "./alerts/alerts.module";
import { AiModule } from "./ai/ai.module";
import { AiActionsModule } from "./ai-actions/ai-actions.module";
import { AutopilotModule } from "./autopilot/autopilot.module";
import { AuthModule } from "./auth/auth.module";
import { BillingModule } from "./billing/billing.module";
import { CompaniesModule } from "./companies/companies.module";
import { ContactsModule } from "./contacts/contacts.module";
import { DealsModule } from "./deals/deals.module";
import { DebugController } from "./debug.controller";
import { DirectoryModule } from "./directory/directory.module";
import { HealthController } from "./health.controller";
import { HealthScoreModule } from "./health-score/health-score.module";
import { GraphModule } from "./graph/graph.module";
import { FixActionsModule } from "./fix-actions/fix-actions.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { HygieneModule } from "./hygiene/hygiene.module";
import { InvoicesModule } from "./invoices/invoices.module";
import { JobsModule } from "./jobs/jobs.module";
import { LeadsModule } from "./leads/leads.module";
import { LlmModule } from "./llm/llm.module";
import { MarketplaceModule } from "./marketplace/marketplace.module";
import { IncidentsModule } from "./incidents/incidents.module";
import { NudgesModule } from "./nudges/nudges.module";
import { OrgMembersModule } from "./org-members/org-members.module";
import { OrgsModule } from "./orgs/orgs.module";
import { OrgAuditModule } from "./org-audit/org-audit.module";
import { OrgApiTokensModule } from "./org-api-tokens/org-api-tokens.module";
import { OrgWebhooksModule } from "./org-webhooks/org-webhooks.module";
import { OnCallModule } from "./oncall/oncall.module";
import { OauthModule } from "./oauth/oauth.module";
import { PortfolioModule } from "./portfolio/portfolio.module";
import { PublicApiModule } from "./public-api/public-api.module";
import { PrismaModule } from "./prisma/prisma.module";
import { ReadyController } from "./ready.controller";
import { RevenueVelocityModule } from "./revenue-velocity/revenue-velocity.module";
import { SecureController } from "./secure/secure.controller";
import { ShieldModule } from "./shield/shield.module";
import { SettingsModule } from "./settings/settings.module";
import { SchedulerModule } from "./scheduler/scheduler.module";
import { StatusModule } from "./status/status.module";
import { TimelineModule } from "./timeline/timeline.module";
import { UsersModule } from "./users/users.module";
import { WorkItemsModule } from "./work-items/work-items.module";
import { IpAllowlistMiddleware } from "./common/middleware/ip-allowlist.middleware";

@Module({
  imports: [
    PrismaModule,
    BillingModule,
    ActivityLogModule,
    AlertsModule,
    AiModule,
    AiActionsModule,
    AutopilotModule,
    AuthModule,
    CompaniesModule,
    ContactsModule,
    DirectoryModule,
    LeadsModule,
    LlmModule,
    MarketplaceModule,
    DealsModule,
    IncidentsModule,
    TimelineModule,
    ShieldModule,
    InvoicesModule,
    WorkItemsModule,
    JobsModule,
    DashboardModule,
    RevenueVelocityModule,
    HealthScoreModule,
    GraphModule,
    FixActionsModule,
    OrgMembersModule,
    OrgsModule,
    OrgAuditModule,
    OrgApiTokensModule,
    OrgWebhooksModule,
    OnCallModule,
    OauthModule,
    PortfolioModule,
    PublicApiModule,
    HygieneModule,
    NudgesModule,
    UsersModule,
    SettingsModule,
    StatusModule,
    SchedulerModule,
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 500
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
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(IpAllowlistMiddleware).forRoutes(
      { path: "billing", method: RequestMethod.ALL },
      { path: "billing/(.*)", method: RequestMethod.ALL },
      { path: "org/api-tokens", method: RequestMethod.ALL },
      { path: "org/api-tokens/(.*)", method: RequestMethod.ALL },
      { path: "org/audit", method: RequestMethod.ALL },
      { path: "org/audit/(.*)", method: RequestMethod.ALL },
      { path: "org/webhooks", method: RequestMethod.ALL },
      { path: "org/webhooks/(.*)", method: RequestMethod.ALL },
      { path: "org/alert-channels", method: RequestMethod.ALL },
      { path: "org/alert-channels/(.*)", method: RequestMethod.ALL },
      { path: "org/alert-deliveries", method: RequestMethod.ALL },
      { path: "org/alert-deliveries/(.*)", method: RequestMethod.ALL },
      { path: "org/escalation-policy", method: RequestMethod.ALL },
      { path: "org/escalation-policy/(.*)", method: RequestMethod.ALL },
      { path: "org/oncall", method: RequestMethod.ALL },
      { path: "org/oncall/(.*)", method: RequestMethod.ALL },
      { path: "org/holidays", method: RequestMethod.ALL },
      { path: "org/holidays/(.*)", method: RequestMethod.ALL },
      { path: "jobs", method: RequestMethod.ALL },
      { path: "jobs/(.*)", method: RequestMethod.ALL }
    );
  }
}
