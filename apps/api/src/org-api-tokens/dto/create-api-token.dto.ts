import { Role } from "@prisma/client";
import { IsArray, IsEnum, IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { KNOWN_API_TOKEN_SCOPES } from "../../auth/token-scope.constants";

export class CreateApiTokenDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @IsIn(KNOWN_API_TOKEN_SCOPES, { each: true })
  scopes?: string[];
}
