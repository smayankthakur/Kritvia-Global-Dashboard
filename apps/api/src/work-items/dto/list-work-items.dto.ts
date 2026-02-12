import { IsEnum, IsIn, IsOptional, IsUUID } from "class-validator";
import { WorkItemStatus } from "@prisma/client";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";

export class ListWorkItemsDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(WorkItemStatus)
  status?: WorkItemStatus;

  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  @IsOptional()
  @IsIn(["overdue", "today", "week", "all"])
  due?: "overdue" | "today" | "week" | "all";
}
