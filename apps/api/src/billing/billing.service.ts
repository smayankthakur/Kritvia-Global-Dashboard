import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { Plan, Subscription } from "@prisma/client";
import { createHmac, timingSafeEqual } from "node:crypto";
import Razorpay from "razorpay";
import { AuthUserContext } from "../auth/auth.types";
import { getActiveOrgId } from "../common/auth-org";
import { PrismaService } from "../prisma/prisma.service";
import { BillableFeatureKey } from "./billing.types";
import { CreateRazorpaySubscriptionDto } from "./dto/create-razorpay-subscription.dto";
import { mapRazorpayWebhookEvent } from "./razorpay-webhook.util";

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

  async createRazorpaySubscription(
    authUser: AuthUserContext,
    dto: CreateRazorpaySubscriptionDto
  ): Promise<{ subscriptionId: string; razorpayKeyId: string }> {
    const orgId = getActiveOrgId({ user: authUser });
    const plan = await this.prisma.plan.findUnique({
      where: { key: dto.planKey }
    });
    if (!plan) {
      throw new HttpException(
        {
          code: "INVALID_PLAN",
          message: "Requested plan does not exist."
        },
        HttpStatus.BAD_REQUEST
      );
    }

    const razorpayPlanId = this.resolveRazorpayPlanId(dto.planKey);
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      throw new HttpException(
        {
          code: "CONFIG_ERROR",
          message: "Razorpay credentials are not configured."
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }

    const org = await this.prisma.org.findUnique({
      where: { id: orgId },
      select: { id: true, name: true }
    });
    if (!org) {
      throw new HttpException(
        {
          code: "ORG_NOT_FOUND",
          message: "Organization not found."
        },
        HttpStatus.NOT_FOUND
      );
    }

    const localSubscription = await this.getSubscriptionForOrg(orgId);
    const client = this.razorpayClient();

    let customerId = localSubscription.razorpayCustomerId ?? null;
    if (!customerId) {
      const customer = await client.customers.create({
        name: authUser.name || org.name,
        email: authUser.email,
        notes: {
          orgId,
          orgName: org.name
        }
      });
      customerId = customer.id;
    }

    const remoteSubscription = (await client.subscriptions.create({
      plan_id: razorpayPlanId,
      customer_notify: 1,
      total_count: 9999,
      notes: {
        orgId,
        planKey: dto.planKey
      }
    })) as { id: string };

    await this.prisma.subscription.update({
      where: { orgId },
      data: {
        razorpayCustomerId: customerId,
        razorpaySubscriptionId: remoteSubscription.id
      }
    });

    return {
      subscriptionId: remoteSubscription.id,
      razorpayKeyId: keyId
    };
  }

  async handleRazorpayWebhook(input: {
    rawBody: Buffer | undefined;
    signature: string | undefined;
    payload: unknown;
  }): Promise<void> {
    this.verifyWebhookSignature(input.rawBody, input.signature);
    const payload = input.payload as { event?: unknown } | null;
    const event = typeof payload?.event === "string" ? payload.event : "";
    const mapped = mapRazorpayWebhookEvent(event, input.payload);
    if (!mapped.razorpaySubscriptionId) {
      return;
    }

    const existing = await this.prisma.subscription.findFirst({
      where: {
        razorpaySubscriptionId: mapped.razorpaySubscriptionId
      },
      include: { plan: true }
    });
    if (!existing) {
      return;
    }

    const nextData: {
      status?: string;
      currentPeriodEnd?: Date | null;
      razorpaySubscriptionId?: string;
      planId?: string;
    } = {};

    if (mapped.status) {
      nextData.status = mapped.status;
    }
    if (mapped.currentPeriodEnd !== undefined) {
      nextData.currentPeriodEnd = mapped.currentPeriodEnd;
    }
    if (mapped.razorpaySubscriptionId) {
      nextData.razorpaySubscriptionId = mapped.razorpaySubscriptionId;
    }

    if (mapped.planKey && (event === "subscription.activated" || event === "subscription.charged")) {
      const mappedPlan = await this.prisma.plan.findUnique({
        where: { key: mapped.planKey },
        select: { id: true }
      });
      if (mappedPlan) {
        nextData.planId = mappedPlan.id;
      }
    }

    if (Object.keys(nextData).length === 0) {
      return;
    }

    await this.prisma.subscription.update({
      where: { id: existing.id },
      data: nextData
    });
  }

  getPortalInfo(): { url: string } {
    return {
      url: "https://dashboard.razorpay.com/app/subscriptions"
    };
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
      enterpriseControlsEnabled: boolean;
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
        enterpriseControlsEnabled: subscription.plan.enterpriseControlsEnabled,
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
    const message =
      featureKey === "enterpriseControlsEnabled"
        ? "Upgrade required to export audit logs."
        : `Upgrade required to use ${this.humanizeFeature(featureKey)}.`;

    throw new HttpException(
      {
        code: "UPGRADE_REQUIRED",
        message
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

  private resolveRazorpayPlanId(planKey: CreateRazorpaySubscriptionDto["planKey"]): string {
    const envByPlan: Record<CreateRazorpaySubscriptionDto["planKey"], string | undefined> = {
      starter: process.env.RAZORPAY_PLAN_STARTER,
      growth: process.env.RAZORPAY_PLAN_GROWTH,
      pro: process.env.RAZORPAY_PLAN_PRO,
      enterprise: process.env.RAZORPAY_PLAN_ENTERPRISE
    };
    const resolved = envByPlan[planKey];
    if (!resolved) {
      throw new HttpException(
        {
          code: "CONFIG_ERROR",
          message: `Razorpay plan ID missing for ${planKey}.`
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
    return resolved;
  }

  private razorpayClient(): Razorpay {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      throw new HttpException(
        {
          code: "CONFIG_ERROR",
          message: "Razorpay credentials are not configured."
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
    return new Razorpay({
      key_id: keyId,
      key_secret: keySecret
    });
  }

  private verifyWebhookSignature(rawBody: Buffer | undefined, signature: string | undefined): void {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      throw new HttpException(
        {
          code: "CONFIG_ERROR",
          message: "Razorpay webhook secret is not configured."
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
    if (!rawBody || !signature) {
      throw new HttpException(
        {
          code: "INVALID_SIGNATURE",
          message: "Invalid Razorpay webhook signature."
        },
        HttpStatus.BAD_REQUEST
      );
    }

    const digest = createHmac("sha256", secret).update(rawBody).digest("hex");
    const expected = Buffer.from(digest, "utf8");
    const received = Buffer.from(signature, "utf8");
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new HttpException(
        {
          code: "INVALID_SIGNATURE",
          message: "Invalid Razorpay webhook signature."
        },
        HttpStatus.BAD_REQUEST
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
      case "enterpriseControlsEnabled":
        return "enterprise controls";
      default:
        return "this feature";
    }
  }
}
