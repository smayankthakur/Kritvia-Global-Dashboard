import { IsIn, IsObject } from "class-validator";

export const APP_COMMANDS = [
  "create_nudge",
  "create_work_item",
  "update_deal_stage"
] as const;

export type AppCommand = (typeof APP_COMMANDS)[number];

export class CreateAppCommandDto {
  @IsIn(APP_COMMANDS)
  command!: AppCommand;

  @IsObject()
  payload!: Record<string, unknown>;
}
