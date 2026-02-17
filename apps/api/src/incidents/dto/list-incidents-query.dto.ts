import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";
import { IsIn, IsOptional } from "class-validator";

export class ListIncidentsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(["OPEN", "ACKNOWLEDGED", "RESOLVED", "POSTMORTEM"])
  status?: "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "POSTMORTEM";

  @IsOptional()
  @IsIn(["CRITICAL", "HIGH", "MEDIUM", "LOW"])
  severity?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
}
