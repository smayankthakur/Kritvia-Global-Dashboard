import { IsUUID } from "class-validator";

export class RetryWebhookDeliveryDto {
  @IsUUID()
  deliveryId!: string;
}
