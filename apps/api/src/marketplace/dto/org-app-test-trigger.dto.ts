import { IsString, MinLength } from "class-validator";

export class OrgAppTestTriggerDto {
  @IsString()
  @MinLength(1)
  eventName!: string;
}
