import { Type } from "class-transformer";
import { IsIn, IsInt, Max, Min } from "class-validator";

export class RepairRecentGraphDto {
  @IsIn(["DEAL", "WORK_ITEM", "INVOICE"])
  entityType!: "DEAL" | "WORK_ITEM" | "INVOICE";

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit!: number;
}
