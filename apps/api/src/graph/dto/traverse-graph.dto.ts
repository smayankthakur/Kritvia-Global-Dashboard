import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min
} from "class-validator";

export class TraverseGraphDto {
  @IsString()
  startNodeId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  maxDepth!: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  edgeTypes?: string[];
}
