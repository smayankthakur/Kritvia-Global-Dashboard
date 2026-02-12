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
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AuthUserContext } from "../auth/auth.types";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SALES_READ_ROLES, SALES_WRITE_ROLES } from "../sales/common/sales-roles";
import { ConvertLeadToDealDto, CreateLeadDto } from "./dto/create-lead.dto";
import { ListLeadsDto } from "./dto/list-leads.dto";
import { UpdateLeadDto } from "./dto/update-lead.dto";
import { LeadsService } from "./leads.service";

@Controller("leads")
@UseGuards(JwtAuthGuard, RolesGuard)
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Get()
  @Roles(...SALES_READ_ROLES)
  async findAll(@Req() req: { user: AuthUserContext }, @Query() query: ListLeadsDto) {
    return this.leadsService.findAll(req.user, query);
  }

  @Post()
  @Roles(...SALES_WRITE_ROLES)
  async create(@Body() dto: CreateLeadDto, @Req() req: { user: AuthUserContext }) {
    return this.leadsService.create(dto, req.user);
  }

  @Patch(":id")
  @Roles(...SALES_WRITE_ROLES)
  async update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateLeadDto,
    @Req() req: { user: AuthUserContext }
  ) {
    return this.leadsService.update(id, dto, req.user);
  }

  @Post(":id/convert-to-deal")
  @Roles(...SALES_WRITE_ROLES)
  async convertToDeal(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ConvertLeadToDealDto,
    @Req() req: { user: AuthUserContext }
  ) {
    return this.leadsService.convertToDeal(id, dto, req.user);
  }
}
