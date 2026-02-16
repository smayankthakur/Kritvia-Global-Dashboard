import { IsUUID } from "class-validator";

export class SwitchOrgDto {
  @IsUUID()
  orgId!: string;
}

