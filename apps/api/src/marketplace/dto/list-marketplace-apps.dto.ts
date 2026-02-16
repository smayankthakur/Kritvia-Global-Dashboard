import { IsOptional, IsString } from "class-validator";

export class ListMarketplaceAppsDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsString()
  category?: string;
}
