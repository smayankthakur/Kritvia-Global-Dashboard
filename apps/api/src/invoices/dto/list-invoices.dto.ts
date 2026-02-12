import { IsEnum, IsOptional, IsUUID } from "class-validator";
import { InvoiceStatus } from "@prisma/client";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";

export class ListInvoicesDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(InvoiceStatus)
  status?: InvoiceStatus;

  @IsOptional()
  @IsUUID()
  companyId?: string;

  @IsOptional()
  @IsUUID()
  dealId?: string;
}
