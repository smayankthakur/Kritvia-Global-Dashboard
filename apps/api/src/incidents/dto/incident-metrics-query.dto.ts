import { IsOptional, Matches } from "class-validator";

export class IncidentMetricsQueryDto {
  @IsOptional()
  @Matches(/^\d+d$/)
  range?: string;
}
