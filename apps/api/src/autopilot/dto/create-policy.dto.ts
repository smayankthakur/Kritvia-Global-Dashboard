import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, Min } from "class-validator";

export class CreateAutopilotPolicyDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsIn(["INVOICE", "WORK_ITEM", "INCIDENT"])
  entityType!: "INVOICE" | "WORK_ITEM" | "INCIDENT";

  @IsObject()
  condition!: Record<string, unknown>;

  @IsString()
  actionTemplateKey!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  riskThreshold?: number;

  @IsOptional()
  @IsBoolean()
  autoExecute?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  maxExecutionsPerHour?: number;
}
