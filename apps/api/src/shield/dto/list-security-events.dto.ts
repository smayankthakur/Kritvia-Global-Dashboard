import { IsBooleanString, IsOptional, IsString } from "class-validator";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";

export class ListSecurityEventsDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  severity?: string;

  @IsOptional()
  @IsBooleanString()
  resolved?: string;
}
