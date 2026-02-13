import { Transform } from "class-transformer";
import { IsIn, IsOptional } from "class-validator";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";

export class ListUsersDto extends PaginationQueryDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.toLowerCase() : value))
  @IsIn(["active", "inactive", "all"])
  active: "active" | "inactive" | "all" = "active";
}

