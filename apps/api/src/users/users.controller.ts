import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards
} from "@nestjs/common";
import { Role } from "@prisma/client";
import { Throttle } from "@nestjs/throttler";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AuthUserContext } from "../auth/auth.types";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { CreateUserDto } from "./dto/create-user.dto";
import { ListUsersDto } from "./dto/list-users.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { UsersService } from "./users.service";

@Controller("users")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.CEO)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  async findAll(@Req() req: { user: AuthUserContext }, @Query() query: ListUsersDto) {
    return this.usersService.findAll(req.user, query);
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async create(@Body() dto: CreateUserDto, @Req() req: { user: AuthUserContext }) {
    return this.usersService.create(dto, req.user);
  }

  @Patch(":id")
  async update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @Req() req: { user: AuthUserContext }
  ) {
    return this.usersService.update(id, dto, req.user);
  }

  @Post(":id/deactivate")
  async deactivate(@Param("id", ParseUUIDPipe) id: string, @Req() req: { user: AuthUserContext }) {
    return this.usersService.deactivate(id, req.user);
  }

  @Post(":id/reactivate")
  async reactivate(@Param("id", ParseUUIDPipe) id: string, @Req() req: { user: AuthUserContext }) {
    return this.usersService.reactivate(id, req.user);
  }
}

