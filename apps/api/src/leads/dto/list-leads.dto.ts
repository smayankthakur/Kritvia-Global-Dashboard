import { IsEnum, IsOptional } from "class-validator";
import { LeadStage } from "@prisma/client";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";

export class ListLeadsDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(LeadStage)
  stage?: LeadStage;
}

