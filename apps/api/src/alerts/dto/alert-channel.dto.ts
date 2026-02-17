import { Type } from "class-transformer";
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateIf } from "class-validator";

export class CreateAlertChannelDto {
  @IsIn(["WEBHOOK", "EMAIL", "SLACK"])
  type!: "WEBHOOK" | "EMAIL" | "SLACK";

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsIn(["MEDIUM", "HIGH", "CRITICAL"])
  minSeverity: "MEDIUM" | "HIGH" | "CRITICAL" = "HIGH";

  @IsOptional()
  config?: Record<string, unknown>;
}

export class UpdateAlertChannelDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsIn(["MEDIUM", "HIGH", "CRITICAL"])
  minSeverity?: "MEDIUM" | "HIGH" | "CRITICAL";

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  config?: Record<string, unknown>;
}

export class TestAlertChannelDto {
  @ValidateIf((obj) => obj.severity !== undefined)
  @IsIn(["MEDIUM", "HIGH", "CRITICAL"])
  severity?: "MEDIUM" | "HIGH" | "CRITICAL";
}
