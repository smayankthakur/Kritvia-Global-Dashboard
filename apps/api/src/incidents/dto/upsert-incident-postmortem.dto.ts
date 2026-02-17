import { IsOptional, IsString } from "class-validator";

export class UpsertIncidentPostmortemDto {
  @IsOptional()
  @IsString()
  summary?: string;

  @IsOptional()
  @IsString()
  rootCause?: string;

  @IsOptional()
  @IsString()
  impact?: string;

  @IsOptional()
  @IsString()
  detectionGap?: string;

  @IsOptional()
  correctiveActions?: unknown;
}
