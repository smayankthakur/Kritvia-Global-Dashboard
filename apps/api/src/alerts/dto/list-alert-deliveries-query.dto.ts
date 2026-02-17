import { IsOptional, IsString } from "class-validator";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";

export class ListAlertDeliveriesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  alertEventId?: string;
}
