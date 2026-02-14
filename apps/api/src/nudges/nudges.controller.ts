import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AuthUserContext } from "../auth/auth.types";
import { NudgesService } from "./nudges.service";
import { CreateNudgeDto } from "./dto/create-nudge.dto";
import { ListNudgesDto } from "./dto/list-nudges.dto";

@Controller("nudges")
@UseGuards(JwtAuthGuard)
export class NudgesController {
  constructor(private readonly nudgesService: NudgesService) {}

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async create(@Body() dto: CreateNudgeDto, @Req() req: { user: AuthUserContext }) {
    return this.nudgesService.create(dto, req.user);
  }

  @Get()
  async list(@Query() query: ListNudgesDto, @Req() req: { user: AuthUserContext }) {
    return this.nudgesService.list(query, req.user);
  }

  @Post("recompute")
  async recompute(@Req() req: { user: AuthUserContext }) {
    return this.nudgesService.recomputeOpenScores(req.user);
  }

  @Post(":id/execute")
  async execute(@Param("id", ParseUUIDPipe) id: string, @Req() req: { user: AuthUserContext }) {
    return this.nudgesService.execute(id, req.user);
  }

  @Post(":id/undo")
  async undo(@Param("id", ParseUUIDPipe) id: string, @Req() req: { user: AuthUserContext }) {
    return this.nudgesService.undo(id, req.user);
  }

  @Post(":id/resolve")
  async resolve(@Param("id", ParseUUIDPipe) id: string, @Req() req: { user: AuthUserContext }) {
    return this.nudgesService.resolve(id, req.user);
  }
}
