import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AutopilotModule } from "../autopilot/autopilot.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { GraphAdminController } from "./graph-admin.controller";
import { GraphController } from "./graph.controller";
import { GraphSyncService } from "./graph-sync.service";
import { GraphService } from "./graph.service";
import { ImpactRadiusController } from "./impact-radius.controller";
import { ImpactRadiusService } from "./impact-radius.service";
import { AutoNudgeService } from "./risk/auto-nudge.service";
import { RiskController } from "./risk/risk.controller";
import { RiskEngineService } from "./risk/risk-engine.service";

@Module({
  imports: [PrismaModule, AuthModule, ActivityLogModule, AutopilotModule],
  controllers: [GraphController, GraphAdminController, ImpactRadiusController, RiskController],
  providers: [GraphService, GraphSyncService, ImpactRadiusService, RiskEngineService, AutoNudgeService],
  exports: [GraphService, GraphSyncService, ImpactRadiusService, RiskEngineService, AutoNudgeService]
})
export class GraphModule {}
