import { IsOptional, IsIn } from "class-validator";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";

export class ListCompanyContactsDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(["createdAt", "name", "title"])
  sortBy: "createdAt" | "name" | "title" | undefined = undefined;
}
