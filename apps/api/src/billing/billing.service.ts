import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { Plan, Subscription } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { BillableFeatureKey } from "./billing.types";

interface SubscriptionWithPlan extends Subscription {
  plan: Plan;
}

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  async getSubscriptionForOrg(orgId: string): Promise<SubscriptionWithPlan> {
    const existing = await this.prisma.subscription.findUnique({
      where: { orgId },
      include: { plan: true }
    });
    if (existing) {
      return existing;
    }

    const starterPlan = await this.prisma.plan.findUnique({
      where: { key: "starter" }
    });
    if (!starterPlan) {
      throw new HttpException(
        {
          code: "CONFIG_ERROR",
          message: "Starter plan is not configured."
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }

    return this.prisma.subscription.create({
      data: {
        orgId,
        planId: starterPlan.id,
        status: "TRIAL"
      },
      include: { plan: true }
    });
  }

  async getPlanForOrg(orgId: string): Promise<Plan> {
    const subscription = await this.getSubscriptionForOrg(orgId);
    return subscription.plan;
  }

  async getPlanDetailsForOrg(orgId: string): Promise<{
    subscription: {
      status: string;
      trialEndsAt: Date | null;
      currentPeriodEnd: Date | null;
    };
    plan: {
      key: string;
      name: string;
      priceMonthly: number;
      seatLimit: number | null;
      orgLimit: number | null;
      autopilotEnabled: boolean;
      shieldEnabled: boolean;
      portfolioEnabled: boolean;
      revenueIntelligenceEnabled: boolean;
      maxWorkItems: number | null;
      maxInvoices: number | null;
    };
  }> {
    const subscription = await this.getSubscriptionForOrg(orgId);
    return {
      subscription: {
        status: subscription.status,
        trialEndsAt: subscription.trialEndsAt,
        currentPeriodEnd: subscription.currentPeriodEnd
      },
      plan: {
        key: subscription.plan.key,
        name: subscription.plan.name,
        priceMonthly: subscription.plan.priceMonthly,
        seatLimit: subscription.plan.seatLimit,
        orgLimit: subscription.plan.orgLimit,
        autopilotEnabled: subscription.plan.autopilotEnabled,
        shieldEnabled: subscription.plan.shieldEnabled,
        portfolioEnabled: subscription.plan.portfolioEnabled,
        revenueIntelligenceEnabled: subscription.plan.revenueIntelligenceEnabled,
        maxWorkItems: subscription.plan.maxWorkItems,
        maxInvoices: subscription.plan.maxInvoices
      }
    };
  }

  async getUsageForOrg(orgId: string): Promise<{
    seatsUsed: number;
    seatLimit: number | null;
    workItemsUsed: number;
    maxWorkItems: number | null;
    invoicesUsed: number;
    maxInvoices: number | null;
    updatedAt: string;
  }> {
    const plan = await this.getPlanForOrg(orgId);
    const [seatsUsed, workItemsUsed, invoicesUsed] = await this.prisma.$transaction([
      this.prisma.orgMember.count({ where: { orgId, status: "ACTIVE" } }),
      this.prisma.workItem.count({ where: { orgId } }),
      this.prisma.invoice.count({ where: { orgId } })
    ]);

    return {
      seatsUsed,
      seatLimit: plan.seatLimit,
      workItemsUsed,
      maxWorkItems: plan.maxWorkItems,
      invoicesUsed,
      maxInvoices: plan.maxInvoices,
      updatedAt: new Date().toISOString()
    };
  }

  async assertFeature(orgId: string, featureKey: BillableFeatureKey): Promise<void> {
    const plan = await this.getPlanForOrg(orgId);
    if (plan[featureKey]) {
      return;
    }

    throw new HttpException(
      {
        code: "UPGRADE_REQUIRED",
        message: `Upgrade required to use ${this.humanizeFeature(featureKey)}.`
      },
      HttpStatus.PAYMENT_REQUIRED
    );
  }

  async assertSeatAvailable(orgId: string): Promise<void> {
    const plan = await this.getPlanForOrg(orgId);
    if (plan.seatLimit == null) {
      return;
    }

    const activeSeats = await this.prisma.orgMember.count({
      where: {
        orgId,
        status: "ACTIVE"
      }
    });

    if (activeSeats >= plan.seatLimit) {
      throw new HttpException(
        {
          code: "UPGRADE_REQUIRED",
          message: "Seat limit reached."
        },
        HttpStatus.PAYMENT_REQUIRED
      );
    }
  }

  async assertWorkItemAvailable(orgId: string): Promise<void> {
    const plan = await this.getPlanForOrg(orgId);
    if (plan.maxWorkItems == null) {
      return;
    }
    const used = await this.prisma.workItem.count({ where: { orgId } });
    if (used >= plan.maxWorkItems) {
      throw new HttpException(
        {
          code: "UPGRADE_REQUIRED",
          message: "Work items limit reached."
        },
        HttpStatus.PAYMENT_REQUIRED
      );
    }
  }

  async assertInvoiceAvailable(orgId: string): Promise<void> {
    const plan = await this.getPlanForOrg(orgId);
    if (plan.maxInvoices == null) {
      return;
    }
    const used = await this.prisma.invoice.count({ where: { orgId } });
    if (used >= plan.maxInvoices) {
      throw new HttpException(
        {
          code: "UPGRADE_REQUIRED",
          message: "Invoices limit reached."
        },
        HttpStatus.PAYMENT_REQUIRED
      );
    }
  }

  private humanizeFeature(featureKey: BillableFeatureKey): string {
    switch (featureKey) {
      case "portfolioEnabled":
        return "Portfolio";
      case "shieldEnabled":
        return "Sudarshan Shield";
      case "revenueIntelligenceEnabled":
        return "Revenue Intelligence";
      case "autopilotEnabled":
        return "Autopilot";
      default:
        return "this feature";
    }
  }
}
