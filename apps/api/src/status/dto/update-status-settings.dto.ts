import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsBoolean,
  IsArray,
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  Max,
  Min
} from "class-validator";

export class UpdateStatusSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "slug must contain lowercase letters, numbers, and hyphens only"
  })
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value))
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  logoUrl?: string;

  @IsOptional()
  @IsString()
  @Matches(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, {
    message: "accentColor must be a valid hex color"
  })
  accentColor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  footerText?: string;

  @IsOptional()
  @IsIn(["PUBLIC", "PRIVATE_TOKEN", "PRIVATE_SSO"])
  visibility?: "PUBLIC" | "PRIVATE_TOKEN" | "PRIVATE_SSO";

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  accessToken?: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  statusAllowedEmailDomains?: string[];

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(1440)
  statusSessionTtlMinutes?: number;
}
