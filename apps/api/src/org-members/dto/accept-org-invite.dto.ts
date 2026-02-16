import { Role } from "@prisma/client";
import { Transform } from "class-transformer";
import { IsOptional, IsString, IsUUID, MinLength } from "class-validator";

export class AcceptOrgInviteDto {
  @IsString()
  token!: string;

  @IsUUID()
  orgId!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;
}

export interface AcceptOrgInviteResponse {
  success: true;
  accessToken?: string;
  user: {
    id: string;
    email: string;
    role: Role;
    orgId: string;
  };
}

