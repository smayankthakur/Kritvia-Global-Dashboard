import { NudgeStatus } from "@prisma/client";
import { IsBooleanString, IsEnum, IsOptional } from "class-validator";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";

export class ListNudgesDto extends PaginationQueryDto {
  @IsOptional()
  @IsBooleanString()
  mine?: string;

  @IsOptional()
  @IsEnum(NudgeStatus)
  status?: NudgeStatus;
}
