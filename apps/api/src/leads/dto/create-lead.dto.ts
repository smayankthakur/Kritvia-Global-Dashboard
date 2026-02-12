import { Type } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min
} from "class-validator";
import { LeadStage } from "@prisma/client";

export class CreateLeadDto {
  @IsString()
  @MaxLength(255)
  title!: string;

  @IsOptional()
  @IsEnum(LeadStage)
  stage?: LeadStage;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  source?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsUUID()
  companyId?: string;

  @IsOptional()
  @IsUUID()
  contactId?: string;

  @IsOptional()
  @IsUUID()
  ownerUserId?: string;
}

export class ConvertLeadToDealDto {
  @IsOptional()
  @IsUUID()
  companyId?: string;

  @IsOptional()
  @IsUUID()
  contactId?: string;

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
  @IsISO8601()
  expectedCloseDate?: string;

  @IsOptional()
  @IsUUID()
  ownerUserId?: string;
}
