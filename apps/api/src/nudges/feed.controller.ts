import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AuthUserContext } from "../auth/auth.types";
import { NudgesService } from "./nudges.service";

@Controller("feed")
@UseGuards(JwtAuthGuard)
export class FeedController {
  constructor(private readonly nudgesService: NudgesService) {}

  @Get()
  async listFeed(@Req() req: { user: AuthUserContext }) {
    return this.nudgesService.feed(req.user);
  }
}
