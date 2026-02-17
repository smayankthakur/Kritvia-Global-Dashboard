import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayUnique, IsArray, IsEmail, IsOptional, IsString, IsUrl, MaxLength } from "class-validator";

export class SubscribeStatusDto {
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  webhookUrl?: string;

  @IsOptional()
  @Type(() => String)
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  componentKeys?: string[];
}
