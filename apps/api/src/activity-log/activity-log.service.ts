import { Injectable } from "@nestjs/common";
import { ActivityEntityType } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export interface ActivityLogInput {
  orgId: string;
  actorUserId?: string;
  entityType: ActivityEntityType;
  entityId: string;
  action: string;
  before?: unknown;
  after?: unknown;
}

@Injectable()
export class ActivityLogService {
  constructor(private readonly prisma: PrismaService) {}

  async log(input: ActivityLogInput): Promise<void> {
    await this.prisma.activityLog.create({
      data: {
        orgId: input.orgId,
        actorUserId: input.actorUserId,
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        beforeJson: input.before as object | undefined,
        afterJson: input.after as object | undefined
      }
    });
  }
}
