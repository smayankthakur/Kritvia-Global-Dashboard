import { IsBoolean, IsInt, Max, Min } from "class-validator";

export class UpdatePolicyDto {
  @IsBoolean()
  lockInvoiceOnSent!: boolean;

  @IsInt()
  @Min(0)
  @Max(90)
  overdueAfterDays!: number;

  @IsInt()
  @Min(0)
  @Max(30)
  defaultWorkDueDays!: number;

  @IsInt()
  @Min(1)
  @Max(60)
  staleDealAfterDays!: number;

  @IsInt()
  @Min(1)
  @Max(720)
  leadStaleAfterHours!: number;

  @IsBoolean()
  requireDealOwner!: boolean;

  @IsBoolean()
  requireWorkOwner!: boolean;

  @IsBoolean()
  requireWorkDueDate!: boolean;

  @IsInt()
  @Min(0)
  @Max(30)
  autoLockInvoiceAfterDays!: number;

  @IsBoolean()
  preventInvoiceUnlockAfterPartialPayment!: boolean;

  @IsBoolean()
  autopilotEnabled!: boolean;

  @IsBoolean()
  autopilotCreateWorkOnDealStageChange!: boolean;

  @IsBoolean()
  autopilotNudgeOnOverdue!: boolean;

  @IsBoolean()
  autopilotAutoStaleDeals!: boolean;
}
