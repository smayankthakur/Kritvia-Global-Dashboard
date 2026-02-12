import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { ActivityEntityType, InvoiceStatus, Prisma } from "@prisma/client";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { AuthUserContext } from "../auth/auth.types";
import { PaginationQueryDto } from "../common/dto/pagination-query.dto";
import { toPaginatedResponse } from "../common/dto/paginated-response.dto";
import { PrismaService } from "../prisma/prisma.service";
import { CreateInvoiceDto } from "./dto/create-invoice.dto";
import { ListInvoicesDto } from "./dto/list-invoices.dto";
import { UpdateInvoiceDto } from "./dto/update-invoice.dto";

const LOCKED_FIELDS: Array<keyof UpdateInvoiceDto> = [
  "companyId",
  "dealId",
  "amount",
  "currency",
  "issueDate",
  "dueDate",
  "invoiceNumber"
];

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLogService: ActivityLogService
  ) {}

  async findAll(authUser: AuthUserContext, query: ListInvoicesDto) {
    const today = startOfUtcDay(new Date());
    const sortBy = this.resolveSortField(query.sortBy);
    const skip = (query.page - 1) * query.pageSize;
    const where: Prisma.InvoiceWhereInput = {
      orgId: authUser.orgId,
      companyId: query.companyId,
      dealId: query.dealId
    };

    if (query.status) {
      if (query.status === InvoiceStatus.OVERDUE) {
        where.status = { not: InvoiceStatus.PAID };
        where.dueDate = { lt: today };
      } else if (query.status === InvoiceStatus.PAID) {
        where.status = InvoiceStatus.PAID;
      } else {
        where.status = query.status;
        where.dueDate = { gte: today };
      }
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.invoice.findMany({
        where,
        orderBy: [{ [sortBy]: query.sortDir }, { id: "asc" }],
        skip,
        take: query.pageSize,
        include: {
          company: { select: { id: true, name: true } },
          deal: { select: { id: true, title: true } },
          createdByUser: { select: { id: true, name: true, email: true } },
          lockedByUser: { select: { id: true, name: true, email: true } }
        }
      }),
      this.prisma.invoice.count({ where })
    ]);

    return toPaginatedResponse(
      rows.map((row) => this.toResponse(row)),
      query.page,
      query.pageSize,
      total
    );
  }

  async getById(id: string, authUser: AuthUserContext) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, orgId: authUser.orgId },
      include: {
        company: { select: { id: true, name: true } },
        deal: { select: { id: true, title: true } },
        createdByUser: { select: { id: true, name: true, email: true } },
        lockedByUser: { select: { id: true, name: true, email: true } }
      }
    });

    if (!invoice) {
      throw new NotFoundException("Invoice not found");
    }

    return this.toResponse(invoice);
  }

  async create(dto: CreateInvoiceDto, authUser: AuthUserContext) {
    await this.ensureCompanyInOrg(dto.companyId, authUser.orgId);
    await this.ensureDealInOrg(dto.dealId, authUser.orgId);

    const created = await this.prisma.invoice.create({
      data: {
        orgId: authUser.orgId,
        invoiceNumber: dto.invoiceNumber,
        companyId: dto.companyId,
        dealId: dto.dealId,
        amount: new Prisma.Decimal(dto.amount),
        currency: dto.currency ?? "INR",
        issueDate: dto.issueDate ? new Date(dto.issueDate) : undefined,
        dueDate: new Date(dto.dueDate),
        createdByUserId: authUser.userId
      }
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.INVOICE,
      entityId: created.id,
      action: "CREATE",
      after: created
    });

    return this.getById(created.id, authUser);
  }

  async update(id: string, dto: UpdateInvoiceDto, authUser: AuthUserContext) {
    const existing = await this.findInvoiceOr404(id, authUser.orgId);

    if (existing.lockedAt && this.hasSensitiveChange(dto)) {
      throw new ConflictException("Invoice is locked after SEND. Unlock before editing.");
    }

    await this.ensureCompanyInOrg(dto.companyId, authUser.orgId);
    await this.ensureDealInOrg(dto.dealId, authUser.orgId);

    const updated = await this.prisma.invoice.update({
      where: { id: existing.id },
      data: {
        invoiceNumber: dto.invoiceNumber,
        companyId: dto.companyId,
        dealId: dto.dealId,
        amount: dto.amount !== undefined ? new Prisma.Decimal(dto.amount) : undefined,
        currency: dto.currency,
        issueDate: dto.issueDate ? new Date(dto.issueDate) : undefined,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined
      }
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.INVOICE,
      entityId: updated.id,
      action: "UPDATE",
      before: existing,
      after: updated
    });

    return this.getById(updated.id, authUser);
  }

  async send(id: string, authUser: AuthUserContext) {
    const existing = await this.findInvoiceOr404(id, authUser.orgId);
    if (existing.status !== InvoiceStatus.DRAFT) {
      throw new BadRequestException("Invoice send is allowed only from DRAFT");
    }

    const updated = await this.prisma.invoice.update({
      where: { id: existing.id },
      data: {
        status: InvoiceStatus.SENT,
        lockedAt: new Date(),
        lockedByUserId: authUser.userId
      }
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.INVOICE,
      entityId: updated.id,
      action: "SEND",
      before: existing,
      after: updated
    });

    return this.getById(updated.id, authUser);
  }

  async markPaid(id: string, authUser: AuthUserContext) {
    const existing = await this.findInvoiceOr404(id, authUser.orgId);
    const effectiveStatus = this.getEffectiveStatus(existing);
    if (effectiveStatus !== InvoiceStatus.SENT && effectiveStatus !== InvoiceStatus.OVERDUE) {
      throw new BadRequestException("Invoice can be marked paid only from SENT or OVERDUE");
    }

    const updated = await this.prisma.invoice.update({
      where: { id: existing.id },
      data: {
        status: InvoiceStatus.PAID
      }
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.INVOICE,
      entityId: updated.id,
      action: "MARK_PAID",
      before: existing,
      after: updated
    });

    return this.getById(updated.id, authUser);
  }

  async unlock(id: string, authUser: AuthUserContext) {
    const existing = await this.findInvoiceOr404(id, authUser.orgId);
    if (!existing.lockedAt) {
      throw new BadRequestException("Invoice is not locked");
    }

    const updated = await this.prisma.invoice.update({
      where: { id: existing.id },
      data: {
        lockedAt: null,
        lockedByUserId: null
      }
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.INVOICE,
      entityId: updated.id,
      action: "UNLOCK",
      before: existing,
      after: updated
    });

    return this.getById(updated.id, authUser);
  }

  async listActivity(id: string, authUser: AuthUserContext, query: PaginationQueryDto) {
    const sortBy = this.resolveActivitySortField(query.sortBy);
    const skip = (query.page - 1) * query.pageSize;
    await this.findInvoiceOr404(id, authUser.orgId);
    const where: Prisma.ActivityLogWhereInput = {
      orgId: authUser.orgId,
      entityType: ActivityEntityType.INVOICE,
      entityId: id
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.activityLog.findMany({
        where,
        orderBy: [{ [sortBy]: query.sortDir }, { id: "asc" }],
        skip,
        take: query.pageSize,
        include: {
          actorUser: {
            select: { id: true, name: true, email: true }
          }
        }
      }),
      this.prisma.activityLog.count({ where })
    ]);

    return toPaginatedResponse(items, query.page, query.pageSize, total);
  }

  private hasSensitiveChange(dto: UpdateInvoiceDto): boolean {
    return LOCKED_FIELDS.some((field) => dto[field] !== undefined);
  }

  private getEffectiveStatus(invoice: { status: InvoiceStatus; dueDate: Date }): InvoiceStatus {
    if (invoice.status === InvoiceStatus.PAID) {
      return InvoiceStatus.PAID;
    }
    const today = startOfUtcDay(new Date());
    const due = startOfUtcDay(invoice.dueDate);
    if (due < today) {
      return InvoiceStatus.OVERDUE;
    }
    return invoice.status;
  }

  private toResponse<T extends { status: InvoiceStatus; dueDate: Date; lockedAt: Date | null }>(invoice: T) {
    return {
      ...invoice,
      effectiveStatus: this.getEffectiveStatus(invoice),
      isLocked: !!invoice.lockedAt
    };
  }

  private async findInvoiceOr404(id: string, orgId: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, orgId }
    });
    if (!invoice) {
      throw new NotFoundException("Invoice not found");
    }
    return invoice;
  }

  private async ensureCompanyInOrg(companyId: string | undefined, orgId: string): Promise<void> {
    if (!companyId) {
      return;
    }
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, orgId }
    });
    if (!company) {
      throw new BadRequestException("Company not found in org");
    }
  }

  private async ensureDealInOrg(dealId: string | undefined, orgId: string): Promise<void> {
    if (!dealId) {
      return;
    }
    const deal = await this.prisma.deal.findFirst({
      where: { id: dealId, orgId }
    });
    if (!deal) {
      throw new BadRequestException("Deal not found in org");
    }
  }

  private resolveSortField(
    sortBy?: string
  ): "createdAt" | "dueDate" | "amount" | "status" | "invoiceNumber" {
    if (!sortBy) {
      return "dueDate";
    }
    if (
      sortBy === "createdAt" ||
      sortBy === "dueDate" ||
      sortBy === "amount" ||
      sortBy === "status" ||
      sortBy === "invoiceNumber"
    ) {
      return sortBy;
    }
    throw new BadRequestException("Invalid sortBy for invoices");
  }

  private resolveActivitySortField(sortBy?: string): "createdAt" | "action" {
    if (!sortBy) {
      return "createdAt";
    }
    if (sortBy === "createdAt" || sortBy === "action") {
      return sortBy;
    }
    throw new BadRequestException("Invalid sortBy for activity");
  }
}
