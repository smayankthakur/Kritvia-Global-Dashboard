import { IsEnum } from "class-validator";
import { WorkItemStatus } from "@prisma/client";

export class TransitionWorkItemDto {
  @IsEnum(WorkItemStatus)
  status!: WorkItemStatus;
}
