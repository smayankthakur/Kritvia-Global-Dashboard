import { mapRazorpayWebhookEvent } from "../src/billing/razorpay-webhook.util";

describe("mapRazorpayWebhookEvent", () => {
  it("maps subscription.activated to ACTIVE with plan key", () => {
    const parsed = mapRazorpayWebhookEvent("subscription.activated", {
      payload: {
        subscription: {
          entity: {
            id: "sub_123",
            current_end: 1767225600,
            notes: { planKey: "pro" }
          }
        }
      }
    });

    expect(parsed.razorpaySubscriptionId).toBe("sub_123");
    expect(parsed.status).toBe("ACTIVE");
    expect(parsed.planKey).toBe("pro");
    expect(parsed.currentPeriodEnd?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("maps payment.failed to PAST_DUE", () => {
    const parsed = mapRazorpayWebhookEvent("payment.failed", {
      payload: {
        payment: {
          entity: {
            subscription_id: "sub_456"
          }
        }
      }
    });

    expect(parsed.razorpaySubscriptionId).toBe("sub_456");
    expect(parsed.status).toBe("PAST_DUE");
  });

  it("maps subscription.cancelled to CANCELED", () => {
    const parsed = mapRazorpayWebhookEvent("subscription.cancelled", {
      payload: {
        subscription: {
          entity: {
            id: "sub_789"
          }
        }
      }
    });

    expect(parsed.razorpaySubscriptionId).toBe("sub_789");
    expect(parsed.status).toBe("CANCELED");
  });
});
