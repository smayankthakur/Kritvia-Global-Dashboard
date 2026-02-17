import { IsArray, IsIn, IsOptional, IsString, MaxLength } from "class-validator";

export class PublishIncidentDto {
  @IsString()
  @MaxLength(500)
  publicSummary!: string;

  @IsOptional()
  @IsArray()
  @IsIn(["api", "web", "db", "webhooks", "ai", "billing"], { each: true })
  componentKeys?: string[];
}
