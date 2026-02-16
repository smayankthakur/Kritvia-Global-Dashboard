import { IsUUID } from "class-validator";

export class AttachPortfolioOrgDto {
  @IsUUID()
  orgId!: string;
}

