import { DealStage } from "@prisma/client";
import { IsEnum, IsOptional, IsUUID } from "class-validator";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";

export class ListDealsDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(DealStage)
  stage?: DealStage;

  @IsOptional()
  @IsUUID()
  companyId?: string;
}

