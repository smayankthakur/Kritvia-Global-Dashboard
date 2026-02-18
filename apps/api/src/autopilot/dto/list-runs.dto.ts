import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, Max, Min } from "class-validator";

export class ListAutopilotRunsDto {
  @IsOptional()
  @IsIn(["INVOICE", "WORK_ITEM", "INCIDENT"])
  entityType?: "INVOICE" | "WORK_ITEM" | "INCIDENT";

  @IsOptional()
  @IsIn(["DRY_RUN", "APPROVAL_REQUIRED", "EXECUTED", "SKIPPED", "FAILED"])
  status?: "DRY_RUN" | "APPROVAL_REQUIRED" | "EXECUTED" | "SKIPPED" | "FAILED";

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}
