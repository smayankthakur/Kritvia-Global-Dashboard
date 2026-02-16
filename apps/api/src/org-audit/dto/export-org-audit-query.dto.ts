import { IsIn, IsOptional, IsString } from "class-validator";

export class ExportOrgAuditQueryDto {
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsIn(["csv"])
  format?: "csv";
}
