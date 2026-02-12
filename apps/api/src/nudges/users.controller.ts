import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AuthUserContext } from "../auth/auth.types";
import { NudgesService } from "./nudges.service";

@Controller("users")
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly nudgesService: NudgesService) {}

  @Get()
  async listUsers(@Req() req: { user: AuthUserContext }) {
    return this.nudgesService.listUsers(req.user);
  }
}
