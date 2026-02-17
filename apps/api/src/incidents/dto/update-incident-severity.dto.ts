import { IsIn } from "class-validator";

export class UpdateIncidentSeverityDto {
  @IsIn(["CRITICAL", "HIGH", "MEDIUM", "LOW"])
  severity!: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
}
