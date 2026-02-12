import { IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

export class CreateCompanyDto {
  @IsString()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  industry?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  website?: string;

  @IsOptional()
  @IsUUID()
  ownerUserId?: string;
}
