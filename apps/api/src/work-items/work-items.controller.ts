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
import { CreateWorkItemDto } from "./dto/create-work-item.dto";
import { ListWorkItemsDto } from "./dto/list-work-items.dto";
import { TransitionWorkItemDto } from "./dto/transition-work-item.dto";
import { UpdateWorkItemDto } from "./dto/update-work-item.dto";
import { WORK_ITEM_READ_ROLES, WORK_ITEM_WRITE_ROLES } from "./work-item-roles";
import { WorkItemsService } from "./work-items.service";

@Controller("work-items")
@UseGuards(JwtAuthGuard, RolesGuard)
export class WorkItemsController {
  constructor(private readonly workItemsService: WorkItemsService) {}

  @Get()
  @Roles(...WORK_ITEM_READ_ROLES)
  async findAll(
    @Req() req: { user: AuthUserContext },
    @Query() query: ListWorkItemsDto
  ) {
    return this.workItemsService.findAll(req.user, query);
  }

  @Post()
  @Roles(...WORK_ITEM_WRITE_ROLES)
  async create(@Body() dto: CreateWorkItemDto, @Req() req: { user: AuthUserContext }) {
    return this.workItemsService.create(dto, req.user);
  }

  @Get(":id")
  @Roles(...WORK_ITEM_READ_ROLES)
  async getById(@Param("id", ParseUUIDPipe) id: string, @Req() req: { user: AuthUserContext }) {
    return this.workItemsService.getById(id, req.user);
  }

  @Patch(":id")
  @Roles(...WORK_ITEM_WRITE_ROLES)
  async update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkItemDto,
    @Req() req: { user: AuthUserContext }
  ) {
    return this.workItemsService.update(id, dto, req.user);
  }

  @Post(":id/transition")
  @Roles(...WORK_ITEM_WRITE_ROLES)
  async transition(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: TransitionWorkItemDto,
    @Req() req: { user: AuthUserContext }
  ) {
    return this.workItemsService.transition(id, dto, req.user);
  }

  @Post(":id/complete")
  @Roles(...WORK_ITEM_WRITE_ROLES)
  async complete(@Param("id", ParseUUIDPipe) id: string, @Req() req: { user: AuthUserContext }) {
    return this.workItemsService.complete(id, req.user);
  }

  @Get(":id/activity")
  @Roles(...WORK_ITEM_READ_ROLES)
  async listActivity(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: PaginationQueryDto,
    @Req() req: { user: AuthUserContext }
  ) {
    return this.workItemsService.listActivity(id, req.user, query);
  }
}
