import { Role } from "@prisma/client";
import { Transform } from "class-transformer";
import { IsEmail, IsEnum } from "class-validator";

export class InviteOrgMemberDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value))
  @IsEmail()
  email!: string;

  @IsEnum(Role)
  role!: Role;
}

