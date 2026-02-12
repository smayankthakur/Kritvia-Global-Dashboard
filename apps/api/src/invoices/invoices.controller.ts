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
import { PaginationQueryDto } from "../common/dto/pagination-query.dto";
import { CreateInvoiceDto } from "./dto/create-invoice.dto";
import { ListInvoicesDto } from "./dto/list-invoices.dto";
import { UpdateInvoiceDto } from "./dto/update-invoice.dto";
import { INVOICE_READ_ROLES, INVOICE_WRITE_ROLES } from "./invoice-roles";
import { InvoicesService } from "./invoices.service";

@Controller("invoices")
@UseGuards(JwtAuthGuard, RolesGuard)
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Get()
  @Roles(...INVOICE_READ_ROLES)
  async findAll(@Req() req: { user: AuthUserContext }, @Query() query: ListInvoicesDto) {
    return this.invoicesService.findAll(req.user, query);
  }

  @Post()
  @Roles(...INVOICE_WRITE_ROLES)
  async create(@Body() dto: CreateInvoiceDto, @Req() req: { user: AuthUserContext }) {
    return this.invoicesService.create(dto, req.user);
  }

  @Get(":id")
  @Roles(...INVOICE_READ_ROLES)
  async getById(@Param("id", ParseUUIDPipe) id: string, @Req() req: { user: AuthUserContext }) {
    return this.invoicesService.getById(id, req.user);
  }

  @Patch(":id")
  @Roles(...INVOICE_WRITE_ROLES)
  async update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateInvoiceDto,
    @Req() req: { user: AuthUserContext }
  ) {
    return this.invoicesService.update(id, dto, req.user);
  }

  @Post(":id/send")
  @Roles(...INVOICE_WRITE_ROLES)
  async send(@Param("id", ParseUUIDPipe) id: string, @Req() req: { user: AuthUserContext }) {
    return this.invoicesService.send(id, req.user);
  }

  @Post(":id/mark-paid")
  @Roles(...INVOICE_WRITE_ROLES)
  async markPaid(@Param("id", ParseUUIDPipe) id: string, @Req() req: { user: AuthUserContext }) {
    return this.invoicesService.markPaid(id, req.user);
  }

  @Post(":id/unlock")
  @Roles(...INVOICE_WRITE_ROLES)
  async unlock(@Param("id", ParseUUIDPipe) id: string, @Req() req: { user: AuthUserContext }) {
    return this.invoicesService.unlock(id, req.user);
  }

  @Get(":id/activity")
  @Roles(...INVOICE_READ_ROLES)
  async listActivity(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: PaginationQueryDto,
    @Req() req: { user: AuthUserContext }
  ) {
    return this.invoicesService.listActivity(id, req.user, query);
  }
}
