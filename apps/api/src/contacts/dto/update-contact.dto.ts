import { IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

export class UpdateContactDto {
  @IsOptional()
  @IsUUID()
  companyId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsUUID()
  ownerUserId?: string;
}
