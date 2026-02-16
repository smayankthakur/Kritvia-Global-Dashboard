import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, Max, Min } from "class-validator";

export class ListLlmReportsDto {
  @IsOptional()
  @IsIn(["CEO_DAILY_BRIEF", "SCORE_DROP_EXPLAIN", "ACTIONS_SUMMARY", "BOARD_MEMO"])
  type?: "CEO_DAILY_BRIEF" | "SCORE_DROP_EXPLAIN" | "ACTIONS_SUMMARY" | "BOARD_MEMO";

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
