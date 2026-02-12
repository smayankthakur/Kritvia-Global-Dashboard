import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AuthUserContext } from "../auth/auth.types";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SALES_READ_ROLES, SALES_WRITE_ROLES } from "../sales/common/sales-roles";
import { CreateContactDto } from "./dto/create-contact.dto";
import { UpdateContactDto } from "./dto/update-contact.dto";
import { ContactsService } from "./contacts.service";

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class ContactsController {
  constructor(private readonly contactsService: ContactsService) {}

  @Get("companies/:companyId/contacts")
  @Roles(...SALES_READ_ROLES)
  async findByCompany(
    @Param("companyId", ParseUUIDPipe) companyId: string,
    @Req() req: { user: AuthUserContext }
  ) {
    return this.contactsService.findByCompany(companyId, req.user);
  }

  @Post("contacts")
  @Roles(...SALES_WRITE_ROLES)
  async create(@Body() dto: CreateContactDto, @Req() req: { user: AuthUserContext }) {
    return this.contactsService.create(dto, req.user);
  }

  @Patch("contacts/:id")
  @Roles(...SALES_WRITE_ROLES)
  async update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateContactDto,
    @Req() req: { user: AuthUserContext }
  ) {
    return this.contactsService.update(id, dto, req.user);
  }
}
