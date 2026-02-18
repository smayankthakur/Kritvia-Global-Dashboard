import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, Max, Min } from "class-validator";

export class RecomputeRiskDto {
  @IsOptional()
  @IsIn(["ORG"])
  scope?: "ORG";

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  maxNodes?: number;
}
