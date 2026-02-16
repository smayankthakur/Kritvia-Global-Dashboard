export type BillableFeatureKey =
  | "autopilotEnabled"
  | "shieldEnabled"
  | "portfolioEnabled"
  | "revenueIntelligenceEnabled";

export class UpgradeRequiredError extends Error {
  constructor(public readonly messageText: string) {
    super(messageText);
    this.name = "UpgradeRequiredError";
  }
}
