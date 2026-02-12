import { Type } from "class-transformer";
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min
} from "class-validator";
import { DealStage } from "@prisma/client";

export class CreateDealDto {
  @IsString()
  @MaxLength(255)
  title!: string;

  @IsUUID()
  companyId!: string;

  @IsOptional()
  @IsUUID()
  ownerUserId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  valueAmount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @IsOptional()
  @IsDateString()
  expectedCloseDate?: string;

  @IsOptional()
  @IsEnum(DealStage)
  stage?: DealStage;
}
