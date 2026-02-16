import { BadRequestException, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { Response } from "express";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

const MAX_EXPORT_RANGE_DAYS = 180;
const EXPORT_CHUNK_SIZE = 2000;

type ActivityLogExportRow = Prisma.ActivityLogGetPayload<{
  include: {
    actorUser: {
      select: {
        email: true;
      };
    };
  };
}>;

interface ExportRange {
  from: Date;
  to: Date;
  fromKey: string;
  toKey: string;
}

@Injectable()
export class OrgAuditService {
  constructor(private readonly prisma: PrismaService) {}

  resolveDateRange(fromRaw?: string, toRaw?: string): ExportRange {
    const now = new Date();
    const toDate = toRaw ? this.parseDateInput(toRaw, false) : new Date(now);
    const fromDate = fromRaw
      ? this.parseDateInput(fromRaw, true)
      : new Date(toDate.getTime() - 29 * 24 * 60 * 60 * 1000);

    if (fromDate > toDate) {
      throw new BadRequestException({
        code: "INVALID_DATE_RANGE",
        message: "'from' must be earlier than or equal to 'to'."
      });
    }

    const rangeMs = toDate.getTime() - fromDate.getTime();
    const maxMs = MAX_EXPORT_RANGE_DAYS * 24 * 60 * 60 * 1000;
    if (rangeMs > maxMs) {
      throw new BadRequestException({
        code: "INVALID_DATE_RANGE",
        message: `Date range cannot exceed ${MAX_EXPORT_RANGE_DAYS} days.`
      });
    }

    return {
      from: fromDate,
      to: toDate,
      fromKey: this.formatDateKey(fromDate),
      toKey: this.formatDateKey(toDate)
    };
  }

  async streamCsvForOrg(orgId: string, range: ExportRange, res: Response): Promise<void> {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit_${orgId}_${range.fromKey}_${range.toKey}.csv"`
    );
    res.setHeader("Cache-Control", "no-store");

    res.write(
      "createdAt,actorUserId,actorEmail,action,entityType,entityId,metaJson,requestId\n"
    );

    let cursorCreatedAt: Date | null = null;
    let cursorId: string | null = null;

    for (;;) {
      const rows: ActivityLogExportRow[] = await this.prisma.activityLog.findMany({
        where: {
          orgId,
          createdAt: {
            gte: range.from,
            lte: range.to
          },
          ...(cursorCreatedAt && cursorId
            ? {
                OR: [
                  {
                    createdAt: {
                      gt: cursorCreatedAt
                    }
                  },
                  {
                    createdAt: cursorCreatedAt,
                    id: {
                      gt: cursorId
                    }
                  }
                ]
              }
            : {})
        },
        include: {
          actorUser: {
            select: {
              email: true
            }
          }
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: EXPORT_CHUNK_SIZE
      });

      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        const combinedMeta = {
          before: row.beforeJson ?? null,
          after: row.afterJson ?? null
        };
        const requestId = this.extractRequestId(row.beforeJson, row.afterJson);
        const csvLine = [
          row.createdAt.toISOString(),
          row.actorUserId ?? "",
          row.actorUser?.email ?? "",
          row.action,
          row.entityType,
          row.entityId,
          JSON.stringify(combinedMeta),
          requestId
        ]
          .map((value) => this.escapeCsv(value))
          .join(",");

        res.write(`${csvLine}\n`);
      }

      const last: ActivityLogExportRow = rows[rows.length - 1];
      cursorCreatedAt = last.createdAt;
      cursorId = last.id;
    }

    res.end();
  }

  validateFormat(format?: string): void {
    if (!format || format === "csv") {
      return;
    }
    throw new HttpException(
      {
        code: "INVALID_FORMAT",
        message: "Only csv format is supported."
      },
      HttpStatus.BAD_REQUEST
    );
  }

  private parseDateInput(input: string, startOfDay: boolean): Date {
    const trimmed = input.trim();
    const dayOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    const parsed = dayOnly
      ? new Date(`${trimmed}T${startOfDay ? "00:00:00.000Z" : "23:59:59.999Z"}`)
      : new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException({
        code: "INVALID_DATE",
        message: `Invalid date value: ${input}`
      });
    }
    return parsed;
  }

  private formatDateKey(value: Date): string {
    return value.toISOString().slice(0, 10);
  }

  private escapeCsv(value: unknown): string {
    const normalized = value == null ? "" : String(value);
    const escaped = normalized.replace(/"/g, "\"\"");
    return `"${escaped}"`;
  }

  private extractRequestId(beforeJson: unknown, afterJson: unknown): string {
    const beforeId = this.readRequestIdFromJson(beforeJson);
    if (beforeId) {
      return beforeId;
    }
    return this.readRequestIdFromJson(afterJson) ?? "";
  }

  private readRequestIdFromJson(value: unknown): string | null {
    if (!value || typeof value !== "object") {
      return null;
    }
    const possible = (value as { requestId?: unknown }).requestId;
    if (typeof possible === "string" && possible.trim().length > 0) {
      return possible;
    }
    return null;
  }
}
