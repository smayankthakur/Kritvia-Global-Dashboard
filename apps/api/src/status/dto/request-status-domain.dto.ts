import { Transform } from "class-transformer";
import { IsString, Matches, MaxLength } from "class-validator";

export class RequestStatusDomainDto {
  @IsString()
  @MaxLength(255)
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value))
  @Matches(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i, {
    message: "domain must be a valid hostname"
  })
  domain!: string;
}
