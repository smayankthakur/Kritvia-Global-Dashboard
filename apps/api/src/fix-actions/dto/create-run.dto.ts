import { IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

export class CreateFixActionRunDto {
  @IsString()
  @MaxLength(80)
  templateKey!: string;

  @IsOptional()
  @IsUUID()
  nudgeId?: string;

  @IsIn(["INVOICE", "WORK_ITEM", "INCIDENT"])
  entityType!: "INVOICE" | "WORK_ITEM" | "INCIDENT";

  @IsUUID()
  entityId!: string;

  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  idempotencyKey?: string;
}
