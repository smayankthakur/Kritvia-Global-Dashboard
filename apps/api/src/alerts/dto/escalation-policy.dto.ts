import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested
} from "class-validator";
import { Type } from "class-transformer";

const SEVERITIES = ["MEDIUM", "HIGH", "CRITICAL"] as const;
const ROUTE_TYPES = [
  "WEBHOOK",
  "EMAIL",
  "SLACK",
  "ONCALL_PRIMARY",
  "ONCALL_SECONDARY",
  "ONCALL_PRIMARY_GLOBAL",
  "ONCALL_PRIMARY_EMAIL",
  "ONCALL_SECONDARY_EMAIL"
] as const;

export class EscalationStepDto {
  @IsInt()
  @Min(1)
  @Max(10080)
  afterMinutes!: number;

  @IsArray()
  @ArrayMinSize(1)
  @IsIn(ROUTE_TYPES, { each: true })
  routeTo!: Array<(typeof ROUTE_TYPES)[number]>;

  @IsIn(SEVERITIES)
  minSeverity!: (typeof SEVERITIES)[number];
}

export class UpsertEscalationPolicyDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsBoolean()
  quietHoursEnabled?: boolean;

  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/)
  quietHoursStart?: string;

  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/)
  quietHoursEnd?: string;

  @IsOptional()
  @IsBoolean()
  businessDaysOnly?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10080)
  slaCritical?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10080)
  slaHigh?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10080)
  slaMedium?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10080)
  slaLow?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => EscalationStepDto)
  steps?: EscalationStepDto[];
}

export class TestEscalationPolicyDto {
  @IsOptional()
  @IsIn(SEVERITIES)
  severity?: (typeof SEVERITIES)[number];
}
