import { BadRequestException, Body, Controller, Headers, HttpCode, Post, Req } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Request } from "express";
import { AppCommandsService } from "./app-commands.service";
import { CreateAppCommandDto } from "./dto/create-app-command.dto";

@Controller("api/v1/apps")
export class AppCommandsController {
  constructor(private readonly appCommandsService: AppCommandsService) {}

  @Post("commands")
  @HttpCode(200)
  @Throttle({ default: { limit: 300, ttl: 60000 } })
  async command(
    @Headers("x-kritviya-org-id") orgId: string | undefined,
    @Headers("x-kritviya-app-key") appKey: string | undefined,
    @Headers("x-kritviya-signature") signature: string | undefined,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Body() body: CreateAppCommandDto,
    @Req() req: Request
  ) {
    if (!orgId || !appKey || !signature || !idempotencyKey) {
      throw new BadRequestException("Missing required app command headers");
    }

    return this.appCommandsService.handleCommand({
      orgId: orgId.trim(),
      appKey: appKey.trim(),
      signature: signature.trim(),
      idempotencyKey: idempotencyKey.trim(),
      body,
      rawBody: req.rawBody,
      requestId: req.requestId
    });
  }
}
