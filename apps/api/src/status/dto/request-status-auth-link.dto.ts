import { Transform } from "class-transformer";
import { IsEmail, IsString, MaxLength, Matches } from "class-validator";

export class RequestStatusAuthLinkDto {
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value))
  orgSlug!: string;

  @IsEmail()
  @MaxLength(255)
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value))
  email!: string;
}
