import { Type } from "class-transformer";
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, Max, Min } from "class-validator";

export class UpdateAlertRuleDto {
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  thresholdCount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  windowMinutes?: number;

  @IsOptional()
  @IsIn(["MEDIUM", "HIGH", "CRITICAL"])
  severity?: "MEDIUM" | "HIGH" | "CRITICAL";

  @IsOptional()
  @IsObject()
  autoMitigation?: {
    action?: "DISABLE_WEBHOOK" | "PAUSE_APP_INSTALL" | "OPEN_CIRCUIT";
    [key: string]: unknown;
  } | null;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  autoCreateIncident?: boolean;
}
