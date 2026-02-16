import { IsObject } from "class-validator";

export class UpdateOrgAppConfigDto {
  @IsObject()
  config!: Record<string, unknown>;
}
