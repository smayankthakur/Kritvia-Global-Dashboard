import { HttpException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ComputeImpactRadiusDto } from "./dto/compute-impact-radius.dto";

type Direction = "OUT" | "IN" | "BOTH";

type ImpactNode = {
  id: string;
  type: string;
  entityId: string;
  title: string | null;
  status: string | null;
  amountCents: number | null;
  currency: string | null;
  dueAt: Date | null;
  occurredAt: Date | null;
  riskScore: number;
};

type ImpactEdge = {
  id: string;
  type: string;
  fromNodeId: string;
  toNodeId: string;
  weight: number;
  createdAt: Date;
};

type ImpactResult = {
  startNode: ImpactNode;
  summary: {
    moneyAtRiskCents: number;
    overdueInvoicesCount: number;
    openWorkCount: number;
    overdueWorkCount: number;
    dealsAtRiskCents: number;
    companiesImpactedCount: number;
    incidentsCount: number;
    maxRiskNode: {
      id: string;
      type: string;
      title: string | null;
      riskScore: number;
    } | null;
    pathCountsByType: Record<string, number>;
  };
  hotspots: Array<{
    id: string;
    type: string;
    title: string | null;
    status: string | null;
    amountCents: number | null;
    dueAt: Date | null;
    riskScore: number;
  }>;
  nodes: ImpactNode[];
  edges: ImpactEdge[];
};

const MAX_DEPTH = 5;
const MAX_NODES = 800;
const MAX_EDGES = 2000;
const CACHE_TTL_MS = 30_000;

@Injectable()
export class ImpactRadiusService {
  private readonly cache = new Map<string, { value: ImpactResult; expiresAt: number }>();

  constructor(private readonly prisma: PrismaService) {}

  async computeImpactRadius(
    orgId: string,
    startNodeId: string,
    opts: Pick<ComputeImpactRadiusDto, "maxDepth" | "direction" | "edgeTypes" | "includeTypes">
  ): Promise<ImpactResult> {
    const normalized = this.normalizeOpts(opts);
    const cacheKey = `${orgId}:${startNodeId}:${JSON.stringify(normalized)}`;
    const nowMs = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > nowMs) {
      return cached.value;
    }

    const startNode = await this.prisma.graphNode.findFirst({
      where: { id: startNodeId, orgId },
      select: this.nodeSelect()
    });
    if (!startNode) {
      throw new NotFoundException("Start node not found");
    }

    const visited = new Set<string>([startNode.id]);
    const edgeIds = new Set<string>();
    let frontier = [startNode.id];

    for (let depth = 1; depth <= normalized.maxDepth; depth += 1) {
      if (frontier.length === 0) {
        break;
      }
      const where = this.buildEdgeWhere(orgId, frontier, normalized.direction, normalized.edgeTypes);
      const edges = await this.prisma.graphEdge.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: MAX_EDGES,
        select: {
          id: true,
          type: true,
          fromNodeId: true,
          toNodeId: true
        }
      });

      const nextFrontier = new Set<string>();
      const frontierSet = new Set(frontier);

      for (const edge of edges) {
        if (edgeIds.size >= MAX_EDGES) {
          throw new HttpException(
            {
              code: "IMPACT_RADIUS_TOO_LARGE",
              message: "Impact radius exceeded max edge cap."
            },
            413
          );
        }
        edgeIds.add(edge.id);

        if (
          normalized.direction === "OUT" &&
          frontierSet.has(edge.fromNodeId) &&
          !visited.has(edge.toNodeId)
        ) {
          if (visited.size >= MAX_NODES) {
            throw new HttpException(
              {
                code: "IMPACT_RADIUS_TOO_LARGE",
                message: "Impact radius exceeded max node cap."
              },
              413
            );
          }
          visited.add(edge.toNodeId);
          nextFrontier.add(edge.toNodeId);
          continue;
        }

        if (
          normalized.direction === "IN" &&
          frontierSet.has(edge.toNodeId) &&
          !visited.has(edge.fromNodeId)
        ) {
          if (visited.size >= MAX_NODES) {
            throw new HttpException(
              {
                code: "IMPACT_RADIUS_TOO_LARGE",
                message: "Impact radius exceeded max node cap."
              },
              413
            );
          }
          visited.add(edge.fromNodeId);
          nextFrontier.add(edge.fromNodeId);
          continue;
        }

        if (normalized.direction === "BOTH") {
          if (frontierSet.has(edge.fromNodeId) && !visited.has(edge.toNodeId)) {
            if (visited.size >= MAX_NODES) {
              throw new HttpException(
                {
                  code: "IMPACT_RADIUS_TOO_LARGE",
                  message: "Impact radius exceeded max node cap."
                },
                413
              );
            }
            visited.add(edge.toNodeId);
            nextFrontier.add(edge.toNodeId);
          }
          if (frontierSet.has(edge.toNodeId) && !visited.has(edge.fromNodeId)) {
            if (visited.size >= MAX_NODES) {
              throw new HttpException(
                {
                  code: "IMPACT_RADIUS_TOO_LARGE",
                  message: "Impact radius exceeded max node cap."
                },
                413
              );
            }
            visited.add(edge.fromNodeId);
            nextFrontier.add(edge.fromNodeId);
          }
        }
      }

      frontier = Array.from(nextFrontier);
    }

    const [allNodes, allEdges] = await this.prisma.$transaction([
      this.prisma.graphNode.findMany({
        where: { orgId, id: { in: Array.from(visited) } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: this.nodeSelect()
      }),
      this.prisma.graphEdge.findMany({
        where: { orgId, id: { in: Array.from(edgeIds) } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          type: true,
          fromNodeId: true,
          toNodeId: true,
          weight: true,
          createdAt: true
        }
      })
    ]);

    const includeTypeSet = normalized.includeTypes ? new Set(normalized.includeTypes) : null;
    const nodes = includeTypeSet
      ? allNodes.filter((node) => includeTypeSet.has(node.type))
      : allNodes;
    const includedNodeIds = new Set(nodes.map((node) => node.id));
    const edges = allEdges.filter(
      (edge) => includedNodeIds.has(edge.fromNodeId) && includedNodeIds.has(edge.toNodeId)
    );

    const result: ImpactResult = {
      startNode,
      summary: this.buildSummary(nodes, edges),
      hotspots: this.buildHotspots(nodes),
      nodes,
      edges
    };

    this.cache.set(cacheKey, { value: result, expiresAt: nowMs + CACHE_TTL_MS });
    this.pruneCache(nowMs);
    return result;
  }

  async mapDeeplink(orgId: string, nodeId: string): Promise<{ url: string | null; label: string }> {
    const node = await this.prisma.graphNode.findFirst({
      where: { id: nodeId, orgId },
      select: { type: true, entityId: true, title: true }
    });
    if (!node) {
      throw new NotFoundException("Graph node not found");
    }

    const mapping: Record<string, string> = {
      DEAL: `/sales/deals/${node.entityId}`,
      WORK_ITEM: `/ops/work/${node.entityId}`,
      INVOICE: `/finance/invoices/${node.entityId}`,
      COMPANY: `/sales/companies/${node.entityId}`,
      CONTACT: `/sales/contacts/${node.entityId}`,
      INCIDENT: `/incidents/${node.entityId}`
    };

    return {
      url: mapping[node.type] ?? null,
      label: node.title ?? node.type
    };
  }

  private buildEdgeWhere(
    orgId: string,
    frontier: string[],
    direction: Direction,
    edgeTypes?: string[]
  ) {
    if (direction === "OUT") {
      return {
        orgId,
        ...(edgeTypes?.length ? { type: { in: edgeTypes } } : {}),
        fromNodeId: { in: frontier }
      };
    }
    if (direction === "IN") {
      return {
        orgId,
        ...(edgeTypes?.length ? { type: { in: edgeTypes } } : {}),
        toNodeId: { in: frontier }
      };
    }
    return {
      orgId,
      ...(edgeTypes?.length ? { type: { in: edgeTypes } } : {}),
      OR: [{ fromNodeId: { in: frontier } }, { toNodeId: { in: frontier } }]
    };
  }

  private nodeSelect() {
    return {
      id: true,
      type: true,
      entityId: true,
      title: true,
      status: true,
      amountCents: true,
      currency: true,
      dueAt: true,
      occurredAt: true,
      riskScore: true
    } as const;
  }

  private buildSummary(nodes: ImpactNode[], edges: ImpactEdge[]) {
    const now = new Date();
    let moneyAtRiskCents = 0;
    let overdueInvoicesCount = 0;
    let openWorkCount = 0;
    let overdueWorkCount = 0;
    let dealsAtRiskCents = 0;
    const companies = new Set<string>();
    const incidents = new Set<string>();
    const pathCountsByType = edges.reduce<Record<string, number>>((acc, edge) => {
      acc[edge.type] = (acc[edge.type] ?? 0) + 1;
      return acc;
    }, {});

    const invoiceRiskStatuses = new Set(["DRAFT", "SENT", "OVERDUE", "UNPAID"]);
    const paidStatuses = new Set(["PAID"]);
    const doneStatuses = new Set(["DONE", "COMPLETED", "CLOSED"]);
    const wonStatuses = new Set(["WON", "CLOSED_WON"]);

    for (const node of nodes) {
      const status = (node.status ?? "").toUpperCase();
      if (node.type === "INVOICE") {
        const overdueByDate = !!node.dueAt && node.dueAt < now && !paidStatuses.has(status);
        if (invoiceRiskStatuses.has(status) || overdueByDate) {
          moneyAtRiskCents += node.amountCents ?? 0;
        }
        if (overdueByDate || status === "OVERDUE") {
          overdueInvoicesCount += 1;
        }
      }
      if (node.type === "WORK_ITEM") {
        const isDone = doneStatuses.has(status);
        if (!isDone) {
          openWorkCount += 1;
          if (node.dueAt && node.dueAt < now) {
            overdueWorkCount += 1;
          }
        }
      }
      if (node.type === "DEAL" && !wonStatuses.has(status)) {
        dealsAtRiskCents += node.amountCents ?? 0;
      }
      if (node.type === "COMPANY") {
        companies.add(node.id);
      }
      if (node.type === "INCIDENT") {
        incidents.add(node.id);
      }
    }

    const maxRiskNode = nodes
      .slice()
      .sort((a, b) => b.riskScore - a.riskScore || a.id.localeCompare(b.id))[0];

    return {
      moneyAtRiskCents,
      overdueInvoicesCount,
      openWorkCount,
      overdueWorkCount,
      dealsAtRiskCents,
      companiesImpactedCount: companies.size,
      incidentsCount: incidents.size,
      maxRiskNode: maxRiskNode
        ? {
            id: maxRiskNode.id,
            type: maxRiskNode.type,
            title: maxRiskNode.title,
            riskScore: maxRiskNode.riskScore
          }
        : null,
      pathCountsByType
    };
  }

  private buildHotspots(nodes: ImpactNode[]) {
    return nodes
      .slice()
      .sort((a, b) => {
        if (b.riskScore !== a.riskScore) {
          return b.riskScore - a.riskScore;
        }
        const aDue = a.dueAt ? a.dueAt.getTime() : Number.POSITIVE_INFINITY;
        const bDue = b.dueAt ? b.dueAt.getTime() : Number.POSITIVE_INFINITY;
        if (aDue !== bDue) {
          return aDue - bDue;
        }
        return (b.amountCents ?? 0) - (a.amountCents ?? 0);
      })
      .slice(0, 10)
      .map((node) => ({
        id: node.id,
        type: node.type,
        title: node.title,
        status: node.status,
        amountCents: node.amountCents,
        dueAt: node.dueAt,
        riskScore: node.riskScore
      }));
  }

  private normalizeOpts(opts: Pick<ComputeImpactRadiusDto, "maxDepth" | "direction" | "edgeTypes" | "includeTypes">) {
    return {
      maxDepth: Math.min(MAX_DEPTH, Math.max(1, opts.maxDepth ?? 3)),
      direction: (opts.direction ?? "BOTH") as Direction,
      edgeTypes: opts.edgeTypes?.length ? opts.edgeTypes : undefined,
      includeTypes: opts.includeTypes?.length ? opts.includeTypes : undefined
    };
  }

  private pruneCache(nowMs: number) {
    if (this.cache.size <= 1000) {
      return;
    }
    for (const [key, value] of this.cache.entries()) {
      if (value.expiresAt <= nowMs) {
        this.cache.delete(key);
      }
    }
  }
}
