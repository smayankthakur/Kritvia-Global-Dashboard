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
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AuthUserContext } from "../auth/auth.types";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SALES_READ_ROLES, SALES_WRITE_ROLES } from "../sales/common/sales-roles";
import { CreateDealDto } from "./dto/create-deal.dto";
import { ListDealsDto } from "./dto/list-deals.dto";
import { UpdateDealDto } from "./dto/update-deal.dto";
import { DealsService } from "./deals.service";

@Controller("deals")
@UseGuards(JwtAuthGuard, RolesGuard)
export class DealsController {
  constructor(private readonly dealsService: DealsService) {}

  @Get()
  @Roles(...SALES_READ_ROLES, Role.FINANCE)
  async findAll(@Req() req: { user: AuthUserContext }, @Query() query: ListDealsDto) {
    return this.dealsService.findAll(req.user, query);
  }

  @Post()
  @Roles(...SALES_WRITE_ROLES)
  async create(@Body() dto: CreateDealDto, @Req() req: { user: AuthUserContext }) {
    return this.dealsService.create(dto, req.user);
  }

  @Patch(":id")
  @Roles(...SALES_WRITE_ROLES)
  async update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateDealDto,
    @Req() req: { user: AuthUserContext }
  ) {
    return this.dealsService.update(id, dto, req.user);
  }

  @Post(":id/mark-won")
  @Roles(...SALES_WRITE_ROLES)
  async markWon(@Param("id", ParseUUIDPipe) id: string, @Req() req: { user: AuthUserContext }) {
    return this.dealsService.markWon(id, req.user);
  }

  @Post(":id/mark-lost")
  @Roles(...SALES_WRITE_ROLES)
  async markLost(@Param("id", ParseUUIDPipe) id: string, @Req() req: { user: AuthUserContext }) {
    return this.dealsService.markLost(id, req.user);
  }
}
