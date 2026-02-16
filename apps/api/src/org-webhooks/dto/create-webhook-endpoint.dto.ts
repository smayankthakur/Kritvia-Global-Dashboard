import { ArrayMaxSize, IsArray, IsString, IsUrl } from "class-validator";

export class CreateWebhookEndpointDto {
  @IsUrl({ require_tld: false }, { message: "url must be a valid URL" })
  url!: string;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  events!: string[];
}
