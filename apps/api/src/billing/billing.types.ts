export type BillableFeatureKey =
  | "autopilotEnabled"
  | "shieldEnabled"
  | "portfolioEnabled"
  | "revenueIntelligenceEnabled"
  | "enterpriseControlsEnabled";

export class UpgradeRequiredError extends Error {
  constructor(public readonly messageText: string) {
    super(messageText);
    this.name = "UpgradeRequiredError";
  }
}
