import { IsString, MaxLength, MinLength } from "class-validator";

export class PublicIncidentUpdateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  message!: string;
}
