import { Injectable, NotFoundException } from "@nestjs/common";
import { AuthUserContext } from "../auth/auth.types";
import { getActiveOrgId } from "../common/auth-org";
import { PrismaService } from "../prisma/prisma.service";
import { ListGraphDto } from "./dto/list-graph.dto";
import { RepairRecentGraphDto } from "./dto/repair-recent-graph.dto";
import { TraverseGraphDto } from "./dto/traverse-graph.dto";
import { GraphSyncService } from "./graph-sync.service";

@Injectable()
export class GraphService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly graphSyncService: GraphSyncService
  ) {}

  async listNodes(authUser: AuthUserContext, query: ListGraphDto) {
    const orgId = getActiveOrgId({ user: authUser });
    const skip = (query.page - 1) * query.pageSize;
    const where = {
      orgId,
      ...(query.type ? { type: query.type } : {}),
      ...(query.q
        ? {
            title: {
              contains: query.q,
              mode: "insensitive" as const
            }
          }
        : {})
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.graphNode.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        skip,
        take: query.pageSize,
        select: {
          id: true,
          type: true,
          entityId: true,
          title: true,
          status: true,
          amountCents: true,
          currency: true,
          dueAt: true,
          occurredAt: true,
          riskScore: true,
          createdAt: true,
          updatedAt: true
        }
      }),
      this.prisma.graphNode.count({ where })
    ]);

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize))
    };
  }

  async listEdges(authUser: AuthUserContext, query: ListGraphDto) {
    const orgId = getActiveOrgId({ user: authUser });
    const skip = (query.page - 1) * query.pageSize;
    const where = {
      orgId,
      ...(query.type ? { type: query.type } : {}),
      ...(query.fromNodeId ? { fromNodeId: query.fromNodeId } : {}),
      ...(query.toNodeId ? { toNodeId: query.toNodeId } : {})
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.graphEdge.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip,
        take: query.pageSize,
        select: {
          id: true,
          type: true,
          weight: true,
          createdAt: true,
          fromNodeId: true,
          toNodeId: true,
          fromNode: {
            select: {
              id: true,
              type: true,
              title: true,
              status: true
            }
          },
          toNode: {
            select: {
              id: true,
              type: true,
              title: true,
              status: true
            }
          }
        }
      }),
      this.prisma.graphEdge.count({ where })
    ]);

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize))
    };
  }

  async getNode(authUser: AuthUserContext, nodeId: string) {
    const orgId = getActiveOrgId({ user: authUser });
    const node = await this.prisma.graphNode.findFirst({
      where: {
        id: nodeId,
        orgId
      },
      select: {
        id: true,
        type: true,
        entityId: true,
        title: true,
        status: true,
        amountCents: true,
        currency: true,
        dueAt: true,
        occurredAt: true,
        riskScore: true,
        createdAt: true,
        updatedAt: true
      }
    });
    if (!node) {
      throw new NotFoundException("Graph node not found");
    }

    const edges = await this.prisma.graphEdge.findMany({
      where: {
        orgId,
        OR: [{ fromNodeId: nodeId }, { toNodeId: nodeId }]
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: 50,
      select: {
        id: true,
        type: true,
        weight: true,
        createdAt: true,
        fromNodeId: true,
        toNodeId: true,
        fromNode: {
          select: {
            id: true,
            type: true,
            title: true,
            status: true
          }
        },
        toNode: {
          select: {
            id: true,
            type: true,
            title: true,
            status: true
          }
        }
      }
    });

    return {
      node,
      edges
    };
  }

  async traverse(authUser: AuthUserContext, dto: TraverseGraphDto) {
    const orgId = getActiveOrgId({ user: authUser });
    const startNode = await this.prisma.graphNode.findFirst({
      where: {
        id: dto.startNodeId,
        orgId
      },
      select: { id: true }
    });
    if (!startNode) {
      throw new NotFoundException("Start node not found");
    }

    const maxNodes = 500;
    const maxEdges = 1000;
    const visited = new Set<string>([dto.startNodeId]);
    let frontier = [dto.startNodeId];
    const edgeMap = new Map<string, { id: string; fromNodeId: string; toNodeId: string }>();

    for (let depth = 1; depth <= dto.maxDepth && frontier.length > 0; depth += 1) {
      const edges = await this.prisma.graphEdge.findMany({
        where: {
          orgId,
          ...(dto.edgeTypes?.length ? { type: { in: dto.edgeTypes } } : {}),
          OR: [{ fromNodeId: { in: frontier } }, { toNodeId: { in: frontier } }]
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: maxEdges
      });

      const frontierSet = new Set(frontier);
      const nextFrontier = new Set<string>();

      for (const edge of edges) {
        if (edgeMap.size >= maxEdges) {
          break;
        }
        if (!edgeMap.has(edge.id)) {
          edgeMap.set(edge.id, {
            id: edge.id,
            fromNodeId: edge.fromNodeId,
            toNodeId: edge.toNodeId
          });
        }

        const connectedIds = frontierSet.has(edge.fromNodeId)
          ? [edge.toNodeId]
          : frontierSet.has(edge.toNodeId)
            ? [edge.fromNodeId]
            : [edge.fromNodeId, edge.toNodeId];

        for (const connectedId of connectedIds) {
          if (visited.size >= maxNodes) {
            break;
          }
          if (!visited.has(connectedId)) {
            visited.add(connectedId);
            nextFrontier.add(connectedId);
          }
        }
      }

      if (visited.size >= maxNodes || edgeMap.size >= maxEdges) {
        break;
      }

      frontier = Array.from(nextFrontier);
    }

    const nodeIds = Array.from(visited);
    const edgeIds = Array.from(edgeMap.keys());

    const [nodes, edges] = await this.prisma.$transaction([
      this.prisma.graphNode.findMany({
        where: {
          orgId,
          id: { in: nodeIds }
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          type: true,
          entityId: true,
          title: true,
          status: true,
          amountCents: true,
          currency: true,
          dueAt: true,
          occurredAt: true,
          riskScore: true,
          createdAt: true,
          updatedAt: true
        }
      }),
      this.prisma.graphEdge.findMany({
        where: {
          orgId,
          id: { in: edgeIds }
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          fromNodeId: true,
          toNodeId: true,
          type: true,
          weight: true,
          createdAt: true
        }
      })
    ]);

    return {
      nodes,
      edges
    };
  }

  async repairDeal(authUser: AuthUserContext, id: string) {
    const orgId = getActiveOrgId({ user: authUser });
    const nodeId = await this.graphSyncService.upsertNodeFromDeal(orgId, id);
    return this.buildRepairResponse(orgId, nodeId);
  }

  async repairWorkItem(authUser: AuthUserContext, id: string) {
    const orgId = getActiveOrgId({ user: authUser });
    const nodeId = await this.graphSyncService.upsertNodeFromWorkItem(orgId, id);
    return this.buildRepairResponse(orgId, nodeId);
  }

  async repairInvoice(authUser: AuthUserContext, id: string) {
    const orgId = getActiveOrgId({ user: authUser });
    const nodeId = await this.graphSyncService.upsertNodeFromInvoice(orgId, id);
    return this.buildRepairResponse(orgId, nodeId);
  }

  async repairRecent(authUser: AuthUserContext, dto: RepairRecentGraphDto) {
    const orgId = getActiveOrgId({ user: authUser });
    const entities = await this.getRecentEntities(orgId, dto);
    const failures: Array<{ entityId: string; error: string }> = [];
    let processed = 0;

    const batchSize = 5;
    for (let index = 0; index < entities.length; index += batchSize) {
      const batch = entities.slice(index, index + batchSize);
      await Promise.all(
        batch.map(async (entity) => {
          try {
            if (dto.entityType === "DEAL") {
              await this.graphSyncService.upsertNodeFromDeal(orgId, entity.id);
            } else if (dto.entityType === "WORK_ITEM") {
              await this.graphSyncService.upsertNodeFromWorkItem(orgId, entity.id);
            } else {
              await this.graphSyncService.upsertNodeFromInvoice(orgId, entity.id);
            }
            processed += 1;
          } catch (error) {
            failures.push({
              entityId: entity.id,
              error: error instanceof Error ? error.message : "Unknown error"
            });
          }
        })
      );
    }

    return {
      processed,
      failed: failures.length,
      failures
    };
  }

  private async buildRepairResponse(orgId: string, nodeId: string) {
    const [node, adjacentEdgesCount] = await this.prisma.$transaction([
      this.prisma.graphNode.findFirst({
        where: { id: nodeId, orgId },
        select: {
          id: true,
          type: true,
          entityId: true,
          title: true,
          status: true,
          amountCents: true,
          currency: true,
          dueAt: true,
          occurredAt: true,
          riskScore: true,
          createdAt: true,
          updatedAt: true
        }
      }),
      this.prisma.graphEdge.count({
        where: {
          orgId,
          OR: [{ fromNodeId: nodeId }, { toNodeId: nodeId }]
        }
      })
    ]);

    if (!node) {
      throw new NotFoundException("Graph node not found");
    }

    return {
      node,
      adjacentEdgesCount
    };
  }

  private async getRecentEntities(orgId: string, dto: RepairRecentGraphDto): Promise<Array<{ id: string }>> {
    if (dto.entityType === "DEAL") {
      return this.prisma.deal.findMany({
        where: { orgId },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        take: dto.limit,
        select: { id: true }
      });
    }
    if (dto.entityType === "WORK_ITEM") {
      return this.prisma.workItem.findMany({
        where: { orgId },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        take: dto.limit,
        select: { id: true }
      });
    }
    return this.prisma.invoice.findMany({
      where: { orgId },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: dto.limit,
      select: { id: true }
    });
  }
}
