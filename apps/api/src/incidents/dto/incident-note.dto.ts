import { IsString, MinLength } from "class-validator";

export class IncidentNoteDto {
  @IsString()
  @MinLength(1)
  message!: string;
}
