import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateIf
} from "class-validator";
import { WorkItemStatus } from "@prisma/client";

export class UpdateWorkItemDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsEnum(WorkItemStatus)
  status?: WorkItemStatus;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  priority?: number;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsDateString()
  dueDate?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  assignedToUserId?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  companyId?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  dealId?: string | null;
}
