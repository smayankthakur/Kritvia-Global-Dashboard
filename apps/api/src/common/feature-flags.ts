import { HttpException, HttpStatus } from "@nestjs/common";

type FeatureFlagKey =
  | "FEATURE_AI_ENABLED"
  | "FEATURE_MARKETPLACE_ENABLED"
  | "FEATURE_AUTOPILOT_ENABLED";

function parseBoolean(value: string | undefined, fallback = true): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value === "true" || value === "1";
}

export function isFeatureEnabled(flag: FeatureFlagKey): boolean {
  return parseBoolean(process.env[flag], true);
}

export function assertFeatureEnabled(flag: FeatureFlagKey): void {
  if (isFeatureEnabled(flag)) {
    return;
  }
  throw new HttpException(
    {
      code: "FEATURE_DISABLED",
      message: `${flag} is disabled.`
    },
    HttpStatus.SERVICE_UNAVAILABLE
  );
}

