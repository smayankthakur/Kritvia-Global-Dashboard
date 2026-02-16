import { IsIn, IsString } from "class-validator";

export class CreateRazorpaySubscriptionDto {
  @IsString()
  @IsIn(["starter", "growth", "pro", "enterprise"])
  planKey!: "starter" | "growth" | "pro" | "enterprise";
}
