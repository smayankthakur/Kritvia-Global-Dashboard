import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { LeadStage } from "@prisma/client";

export class UpdateLeadDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

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
