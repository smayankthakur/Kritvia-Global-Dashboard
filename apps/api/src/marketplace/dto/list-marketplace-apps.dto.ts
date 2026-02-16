import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";
import { IsOptional, IsString } from "class-validator";

export class ListMarketplaceAppsDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsString()
  category?: string;
}
