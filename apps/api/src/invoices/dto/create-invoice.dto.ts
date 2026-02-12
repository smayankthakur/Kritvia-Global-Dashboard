import { Type } from "class-transformer";
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min
} from "class-validator";

export class CreateInvoiceDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  invoiceNumber?: string;

  @IsUUID()
  companyId!: string;

  @IsOptional()
  @IsUUID()
  dealId?: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @IsOptional()
  @IsDateString()
  issueDate?: string;

  @IsDateString()
  dueDate!: string;
}
