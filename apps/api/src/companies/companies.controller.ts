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
import { Role } from "@prisma/client";
import { SALES_READ_ROLES, SALES_WRITE_ROLES } from "../sales/common/sales-roles";
import { PaginationQueryDto } from "../common/dto/pagination-query.dto";
import { CompaniesService } from "./companies.service";
import { CreateCompanyDto } from "./dto/create-company.dto";
import { UpdateCompanyDto } from "./dto/update-company.dto";

@Controller("companies")
@UseGuards(JwtAuthGuard, RolesGuard)
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  @Get()
  @Roles(...SALES_READ_ROLES, Role.FINANCE)
  async findAll(@Req() req: { user: AuthUserContext }, @Query() query: PaginationQueryDto) {
    return this.companiesService.findAll(req.user, query);
  }

  @Get(":id")
  @Roles(...SALES_READ_ROLES, Role.FINANCE)
  async findOne(@Param("id", ParseUUIDPipe) id: string, @Req() req: { user: AuthUserContext }) {
    return this.companiesService.findOne(id, req.user);
  }

  @Post()
  @Roles(...SALES_WRITE_ROLES)
  async create(@Body() dto: CreateCompanyDto, @Req() req: { user: AuthUserContext }) {
    return this.companiesService.create(dto, req.user);
  }

  @Patch(":id")
  @Roles(...SALES_WRITE_ROLES)
  async update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateCompanyDto,
    @Req() req: { user: AuthUserContext }
  ) {
    return this.companiesService.update(id, dto, req.user);
  }
}
