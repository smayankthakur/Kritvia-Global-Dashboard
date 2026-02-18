import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min
} from "class-validator";

export class ImpactRadiusQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  maxDepth?: number;

  @IsOptional()
  @IsIn(["OUT", "IN", "BOTH"])
  direction?: "OUT" | "IN" | "BOTH";

  @IsOptional()
  @Transform(({ value }) => (Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : []))
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  edgeTypes?: string[];
}
