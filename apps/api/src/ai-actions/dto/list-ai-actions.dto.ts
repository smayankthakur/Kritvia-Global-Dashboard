import { IsIn, IsOptional } from "class-validator";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";

export class ListAiActionsDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(["PROPOSED", "APPROVED", "EXECUTED", "FAILED", "CANCELED"])
  status?: "PROPOSED" | "APPROVED" | "EXECUTED" | "FAILED" | "CANCELED";
}
