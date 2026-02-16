export type LocalSubscriptionStatus = "TRIAL" | "ACTIVE" | "PAST_DUE" | "CANCELED";

export interface RazorpayWebhookParsed {
  razorpaySubscriptionId?: string;
  status?: LocalSubscriptionStatus;
  currentPeriodEnd?: Date | null;
  planKey?: "starter" | "growth" | "pro" | "enterprise";
}

function parsePlanKey(value: unknown): RazorpayWebhookParsed["planKey"] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "starter" ||
    normalized === "growth" ||
    normalized === "pro" ||
    normalized === "enterprise"
  ) {
    return normalized;
  }
  return undefined;
}

function parseUnixTimestamp(value: unknown): Date | null | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(value * 1000);
}

interface RazorpaySubscriptionEntity {
  id?: unknown;
  current_end?: unknown;
  notes?: Record<string, unknown>;
}

interface RazorpayPaymentEntity {
  subscription_id?: unknown;
}

interface RazorpayWebhookPayload {
  payload?: {
    subscription?: {
      entity?: RazorpaySubscriptionEntity;
    };
    payment?: {
      entity?: RazorpayPaymentEntity;
    };
  };
}

function getSubscriptionEntity(payload: RazorpayWebhookPayload): RazorpaySubscriptionEntity | null {
  return payload.payload?.subscription?.entity ?? null;
}

export function mapRazorpayWebhookEvent(event: string, payload: unknown): RazorpayWebhookParsed {
  const typedPayload = (payload as RazorpayWebhookPayload | null) ?? {};
  const subscription = getSubscriptionEntity(typedPayload);
  const payment = typedPayload.payload?.payment?.entity ?? null;
  const subscriptionId =
    (typeof subscription?.id === "string" ? subscription.id : undefined) ??
    (typeof payment?.subscription_id === "string" ? payment.subscription_id : undefined);

  const currentPeriodEnd = parseUnixTimestamp(subscription?.current_end);
  const planKey = parsePlanKey(subscription?.notes?.planKey ?? subscription?.notes?.plan_key);

  if (event === "subscription.activated") {
    return {
      razorpaySubscriptionId: subscriptionId,
      status: "ACTIVE",
      currentPeriodEnd,
      planKey
    };
  }
  if (event === "subscription.charged") {
    return {
      razorpaySubscriptionId: subscriptionId,
      status: "ACTIVE",
      currentPeriodEnd
    };
  }
  if (event === "subscription.halted" || event === "subscription.paused" || event === "payment.failed") {
    return {
      razorpaySubscriptionId: subscriptionId,
      status: "PAST_DUE",
      currentPeriodEnd
    };
  }
  if (event === "subscription.cancelled") {
    return {
      razorpaySubscriptionId: subscriptionId,
      status: "CANCELED",
      currentPeriodEnd
    };
  }

  return {
    razorpaySubscriptionId: subscriptionId,
    currentPeriodEnd
  };
}
