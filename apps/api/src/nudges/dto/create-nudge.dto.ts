import { ActivityEntityType } from "@prisma/client";
import { IsEnum, IsString, IsUUID, MaxLength } from "class-validator";

export class CreateNudgeDto {
  @IsUUID()
  targetUserId!: string;

  @IsEnum(ActivityEntityType)
  entityType!: ActivityEntityType;

  @IsUUID()
  entityId!: string;

  @IsString()
  @MaxLength(500)
  message!: string;
}
