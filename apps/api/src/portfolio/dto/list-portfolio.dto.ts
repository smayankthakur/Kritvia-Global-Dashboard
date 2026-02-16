import { IsOptional, IsIn } from "class-validator";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";

export class ListPortfolioDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(["createdAt", "name", "role"])
  sortBy: "createdAt" | "name" | "role" | undefined = undefined;
}
