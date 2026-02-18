import { IsBoolean } from "class-validator";

export class ConfirmFixActionRunDto {
  @IsBoolean()
  confirm!: boolean;
}
