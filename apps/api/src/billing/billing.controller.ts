import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Req,
  UseGuards
} from "@nestjs/common";
import { Role } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { getActiveOrgId } from "../common/auth-org";
import { CreateRazorpaySubscriptionDto } from "./dto/create-razorpay-subscription.dto";
import { BillingService } from "./billing.service";

@Controller("billing")
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get("plan")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CEO, Role.ADMIN)
  async getPlan(@Req() req: { user: AuthUserContext }) {
    const orgId = getActiveOrgId({ user: req.user });
    return this.billingService.getPlanDetailsForOrg(orgId);
  }

  @Post("create-subscription")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CEO, Role.ADMIN)
  async createSubscription(
    @Req() req: { user: AuthUserContext },
    @Body() dto: CreateRazorpaySubscriptionDto
  ) {
    return this.billingService.createRazorpaySubscription(req.user, dto);
  }

  @Post("webhook")
  async webhook(
    @Req() req: { rawBody?: Buffer; body: unknown },
    @Headers("x-razorpay-signature") signature: string | undefined
  ) {
    await this.billingService.handleRazorpayWebhook({
      rawBody: req.rawBody,
      signature,
      payload: req.body
    });
    return { received: true };
  }

  @Get("portal")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CEO, Role.ADMIN)
  async getPortal() {
    return this.billingService.getPortalInfo();
  }
}
