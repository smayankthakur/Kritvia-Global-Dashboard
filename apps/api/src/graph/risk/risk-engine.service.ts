import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { isFeatureEnabled } from "../../common/feature-flags";
import { PrismaService } from "../../prisma/prisma.service";
import { AutopilotService } from "../../autopilot/autopilot.service";
import { AutoNudgeService } from "./auto-nudge.service";

const HARD_MAX_NODES = 5000;
const DEFAULT_MAX_NODES = 2000;
const MAX_EDGES = 15000;
const PROPAGATION_ROUNDS = 3;

const DONE_WORK_STATUSES = new Set(["DONE", "COMPLETED", "CLOSED"]);
const WON_DEAL_STATUSES = new Set(["WON", "CLOSED_WON"]);
const PAID_INVOICE_STATUSES = new Set(["PAID"]);
const RISK_INVOICE_STATUSES = new Set(["SENT", "OVERDUE", "UNPAID"]);

const EDGE_FACTORS: Record<string, number> = {
  BLOCKS: 0.25,
  DEPENDS_ON: 0.25,
  BILLED_BY: 0.2,
  CREATED_FROM: 0.15,
  RELATES_TO: 0.1,
  ASSIGNED_TO: 0.05
};

type GraphNodeLite = {
  id: string;
  orgId: string;
  type: string;
  entityId: string;
  title: string | null;
  status: string | null;
  amountCents: number | null;
  currency: string | null;
  dueAt: Date | null;
  occurredAt: Date | null;
  riskScore: number;
  updatedAt: Date;
};

type GraphEdgeLite = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  type: string;
  weight: number;
  createdAt: Date;
};

export type RiskReasonCode =
  | "INVOICE_OVERDUE"
  | "INVOICE_HIGH_AMOUNT"
  | "WORK_OVERDUE"
  | "WORK_BLOCKED"
  | "INCIDENT_OPEN"
  | `PROPAGATED_FROM_${string}`;

export type RiskDriver = {
  nodeId: string;
  entityId: string;
  type: string;
  title: string | null;
  riskScore: number;
  reasonCodes: RiskReasonCode[];
  evidence: {
    dueAt?: string;
    amountCents?: number;
    status?: string;
    counts?: Record<string, number>;
  };
  deeplink?: { url: string; label: string };
};

export type RiskComputeResult = {
  orgRiskScore: number;
  nodeUpdates: Array<{ nodeId: string; riskScore: number; reasons: RiskReasonCode[] }>;
  topDrivers: RiskDriver[];
  deltas: { vsYesterday: number | null };
};

type NodeRiskState = {
  baseRisk: number;
  risk: number;
  reasons: Set<RiskReasonCode>;
  incomingByType: Map<string, number>;
};

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function clamp0to100(value: number): number {
  if (value <= 0) {
    return 0;
  }
  if (value >= 100) {
    return 100;
  }
  return Math.round(value);
}

function mean(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, item) => sum + item, 0) / values.length;
}

@Injectable()
export class RiskEngineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly autoNudgeService: AutoNudgeService,
    private readonly autopilotService: AutopilotService
  ) {}

  async computeOrgRisk(orgId: string, opts?: { maxNodes?: number }): Promise<RiskComputeResult> {
    const maxNodes = Math.min(HARD_MAX_NODES, Math.max(1, opts?.maxNodes ?? DEFAULT_MAX_NODES));
    const loaded = await this.loadGraph(orgId, maxNodes);
    const now = new Date();

    if (loaded.nodes.length === 0) {
      const emptyDrivers: RiskDriver[] = [];
      const asOfDate = startOfUtcDay(now);
      await this.prisma.orgRiskSnapshot.upsert({
        where: { orgId_asOfDate: { orgId, asOfDate } },
        create: {
          orgId,
          asOfDate,
          riskScore: 0,
          drivers: emptyDrivers as unknown as Prisma.InputJsonValue,
          meta: { nodeCount: 0, edgeCount: 0 } as Prisma.InputJsonValue
        },
        update: {
          riskScore: 0,
          drivers: emptyDrivers as unknown as Prisma.InputJsonValue,
          meta: { nodeCount: 0, edgeCount: 0 } as Prisma.InputJsonValue
        }
      });

      const yesterday = new Date(asOfDate);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const yesterdaySnapshot = await this.prisma.orgRiskSnapshot.findUnique({
        where: { orgId_asOfDate: { orgId, asOfDate: yesterday } },
        select: { riskScore: true }
      });

      return {
        orgRiskScore: 0,
        nodeUpdates: [],
        topDrivers: emptyDrivers,
        deltas: {
          vsYesterday: yesterdaySnapshot ? 0 - yesterdaySnapshot.riskScore : null
        }
      };
    }

    const nodeById = new Map(loaded.nodes.map((node) => [node.id, node]));
    const invoiceAmountScale = this.buildAmountScale(loaded.nodes, "INVOICE", 20);
    const dealAmountScale = this.buildAmountScale(loaded.nodes, "DEAL", 25);

    const stateByNode = new Map<string, NodeRiskState>();
    for (const node of loaded.nodes) {
      const base = this.computeBaseRisk(node, now, invoiceAmountScale, dealAmountScale);
      stateByNode.set(node.id, {
        baseRisk: base.risk,
        risk: base.risk,
        reasons: new Set(base.reasons),
        incomingByType: new Map()
      });
    }

    const edges = loaded.edges
      .filter((edge) => stateByNode.has(edge.fromNodeId) && stateByNode.has(edge.toNodeId))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));

    for (let round = 0; round < PROPAGATION_ROUNDS; round += 1) {
      const incrementByNode = new Map<string, number>();

      for (const edge of edges) {
        const fromState = stateByNode.get(edge.fromNodeId);
        if (!fromState || fromState.risk <= 0) {
          continue;
        }

        const factor = EDGE_FACTORS[edge.type] ?? 0;
        if (factor <= 0) {
          continue;
        }

        const normalizedWeight = Math.min(5, Math.max(1, edge.weight || 1));
        const propagated = fromState.risk * factor * normalizedWeight;
        if (propagated <= 0.5) {
          continue;
        }

        const previous = incrementByNode.get(edge.toNodeId) ?? 0;
        incrementByNode.set(edge.toNodeId, previous + propagated);

        const targetState = stateByNode.get(edge.toNodeId);
        const sourceNode = nodeById.get(edge.fromNodeId);
        if (targetState && sourceNode) {
          const reason = `PROPAGATED_FROM_${sourceNode.type}` as RiskReasonCode;
          targetState.reasons.add(reason);
          targetState.incomingByType.set(
            sourceNode.type,
            (targetState.incomingByType.get(sourceNode.type) ?? 0) + propagated
          );
        }
      }

      for (const [nodeId, increment] of incrementByNode.entries()) {
        const state = stateByNode.get(nodeId);
        if (!state) {
          continue;
        }
        state.risk = clamp0to100(state.risk + increment);
      }
    }

    const updates = loaded.nodes
      .map((node) => {
        const state = stateByNode.get(node.id);
        if (!state) {
          return null;
        }
        return {
          node,
          nextRisk: state.risk,
          changed: node.riskScore !== state.risk,
          reasons: Array.from(state.reasons)
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    const changed = updates.filter((item) => item.changed);
    for (let index = 0; index < changed.length; index += 200) {
      const chunk = changed.slice(index, index + 200);
      await this.prisma.$transaction(
        chunk.map((item) =>
          this.prisma.graphNode.update({
            where: { id: item.node.id },
            data: { riskScore: item.nextRisk }
          })
        )
      );
    }

    const scoredNodes = updates.map((item) => ({ ...item.node, riskScore: item.nextRisk }));

    const invoiceTop = scoredNodes
      .filter((node) => node.type === "INVOICE")
      .sort((a, b) => b.riskScore - a.riskScore)
      .slice(0, 20)
      .map((node) => node.riskScore);
    const workTop = scoredNodes
      .filter((node) => node.type === "WORK_ITEM")
      .sort((a, b) => b.riskScore - a.riskScore)
      .slice(0, 20)
      .map((node) => node.riskScore);
    const otherTop = scoredNodes
      .filter((node) => node.type !== "INVOICE" && node.type !== "WORK_ITEM")
      .sort((a, b) => b.riskScore - a.riskScore)
      .slice(0, 10)
      .map((node) => node.riskScore);

    const orgRiskScore = clamp0to100(
      0.45 * mean(invoiceTop) + 0.35 * mean(workTop) + 0.2 * mean(otherTop)
    );

    const topDrivers = scoredNodes
      .slice()
      .sort((a, b) => b.riskScore - a.riskScore || a.id.localeCompare(b.id))
      .slice(0, 10)
      .map((node) => {
        const nodeState = stateByNode.get(node.id);
        return this.toDriver(node, nodeState);
      });

    const asOfDate = startOfUtcDay(now);
    await this.prisma.orgRiskSnapshot.upsert({
      where: {
        orgId_asOfDate: {
          orgId,
          asOfDate
        }
      },
      create: {
        orgId,
        asOfDate,
        riskScore: orgRiskScore,
        drivers: topDrivers as unknown as Prisma.InputJsonValue,
        meta: {
          nodeCount: loaded.nodes.length,
          edgeCount: loaded.edges.length,
          updatedNodesCount: changed.length
        } as Prisma.InputJsonValue
      },
      update: {
        riskScore: orgRiskScore,
        drivers: topDrivers as unknown as Prisma.InputJsonValue,
        meta: {
          nodeCount: loaded.nodes.length,
          edgeCount: loaded.edges.length,
          updatedNodesCount: changed.length
        } as Prisma.InputJsonValue
      }
    });

    if (isFeatureEnabled("FEATURE_RISK_AUTO_NUDGES")) {
      await this.autoNudgeService.generateRiskNudges(orgId, topDrivers, asOfDate);
    }

    if (isFeatureEnabled("FEATURE_AUTOPILOT_ENABLED") || isFeatureEnabled("FEATURE_AUTOPILOT")) {
      for (const driver of topDrivers) {
        await this.autopilotService.evaluateAndExecute(orgId, driver);
      }
    }

    const yesterday = new Date(asOfDate);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdaySnapshot = await this.prisma.orgRiskSnapshot.findUnique({
      where: {
        orgId_asOfDate: {
          orgId,
          asOfDate: yesterday
        }
      },
      select: { riskScore: true }
    });

    return {
      orgRiskScore,
      nodeUpdates: changed.map((item) => ({
        nodeId: item.node.id,
        riskScore: item.nextRisk,
        reasons: item.reasons
      })),
      topDrivers,
      deltas: {
        vsYesterday: yesterdaySnapshot ? orgRiskScore - yesterdaySnapshot.riskScore : null
      }
    };
  }

  async getLatestRisk(orgId: string) {
    const latest = await this.prisma.orgRiskSnapshot.findFirst({
      where: { orgId },
      orderBy: [{ asOfDate: "desc" }, { createdAt: "desc" }],
      select: {
        asOfDate: true,
        riskScore: true,
        drivers: true,
        createdAt: true
      }
    });

    if (!latest) {
      const computed = await this.computeOrgRisk(orgId);
      return {
        orgRiskScore: computed.orgRiskScore,
        deltaVsYesterday: computed.deltas.vsYesterday,
        topDrivers: computed.topDrivers,
        generatedAt: new Date().toISOString()
      };
    }

    const yesterday = new Date(latest.asOfDate);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdaySnapshot = await this.prisma.orgRiskSnapshot.findUnique({
      where: {
        orgId_asOfDate: {
          orgId,
          asOfDate: yesterday
        }
      },
      select: { riskScore: true }
    });

    return {
      orgRiskScore: latest.riskScore,
      deltaVsYesterday: yesterdaySnapshot ? latest.riskScore - yesterdaySnapshot.riskScore : null,
      topDrivers: Array.isArray(latest.drivers) ? (latest.drivers as unknown as RiskDriver[]) : [],
      generatedAt: latest.createdAt.toISOString()
    };
  }

  async getRiskWhy(orgId: string) {
    const latest = await this.prisma.orgRiskSnapshot.findFirst({
      where: { orgId },
      orderBy: [{ asOfDate: "desc" }, { createdAt: "desc" }],
      select: {
        drivers: true,
        createdAt: true
      }
    });

    if (!latest) {
      const computed = await this.computeOrgRisk(orgId);
      return {
        drivers: computed.topDrivers,
        generatedAt: new Date().toISOString()
      };
    }

    return {
      drivers: Array.isArray(latest.drivers) ? (latest.drivers as unknown as RiskDriver[]) : [],
      generatedAt: latest.createdAt.toISOString()
    };
  }

  private async loadGraph(orgId: string, maxNodes: number): Promise<{ nodes: GraphNodeLite[]; edges: GraphEdgeLite[] }> {
    const nodes = await this.prisma.graphNode.findMany({
      where: { orgId },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: maxNodes,
      select: {
        id: true,
        orgId: true,
        type: true,
        entityId: true,
        title: true,
        status: true,
        amountCents: true,
        currency: true,
        dueAt: true,
        occurredAt: true,
        riskScore: true,
        updatedAt: true
      }
    });

    const nodeIds = nodes.map((node) => node.id);
    if (!nodeIds.length) {
      return { nodes, edges: [] };
    }

    const edges = await this.prisma.graphEdge.findMany({
      where: {
        orgId,
        OR: [{ fromNodeId: { in: nodeIds } }, { toNodeId: { in: nodeIds } }]
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: MAX_EDGES,
      select: {
        id: true,
        fromNodeId: true,
        toNodeId: true,
        type: true,
        weight: true,
        createdAt: true
      }
    });

    return {
      nodes,
      edges: edges.filter((edge) => nodeIds.includes(edge.fromNodeId) && nodeIds.includes(edge.toNodeId))
    };
  }

  private buildAmountScale(nodes: GraphNodeLite[], type: string, maxBoost: number): Map<string, number> {
    const bucketNodes = nodes
      .filter((node) => node.type === type && typeof node.amountCents === "number" && node.amountCents > 0)
      .sort((a, b) => (a.amountCents ?? 0) - (b.amountCents ?? 0));

    const map = new Map<string, number>();
    if (!bucketNodes.length) {
      return map;
    }

    if (bucketNodes.length === 1) {
      map.set(bucketNodes[0].id, maxBoost);
      return map;
    }

    for (let index = 0; index < bucketNodes.length; index += 1) {
      const percentile = index / (bucketNodes.length - 1);
      map.set(bucketNodes[index].id, Math.round(percentile * maxBoost));
    }

    return map;
  }

  private computeBaseRisk(
    node: GraphNodeLite,
    now: Date,
    invoiceAmountScale: Map<string, number>,
    dealAmountScale: Map<string, number>
  ): { risk: number; reasons: RiskReasonCode[] } {
    const status = (node.status ?? "").toUpperCase();
    let risk = 0;
    const reasons: RiskReasonCode[] = [];

    if (node.type === "INVOICE") {
      if (PAID_INVOICE_STATUSES.has(status)) {
        return { risk: 0, reasons };
      }

      if (node.dueAt && node.dueAt < now) {
        risk += 60;
        reasons.push("INVOICE_OVERDUE");
      }
      if (RISK_INVOICE_STATUSES.has(status)) {
        risk += 20;
      }
      const amountBoost = invoiceAmountScale.get(node.id) ?? 0;
      if (amountBoost > 0) {
        risk += amountBoost;
        reasons.push("INVOICE_HIGH_AMOUNT");
      }
      return { risk: clamp0to100(risk), reasons };
    }

    if (node.type === "WORK_ITEM") {
      if (DONE_WORK_STATUSES.has(status)) {
        return { risk: 0, reasons };
      }
      if (node.dueAt && node.dueAt < now) {
        risk += 50;
        reasons.push("WORK_OVERDUE");
      }
      if (status === "BLOCKED") {
        risk += 25;
        reasons.push("WORK_BLOCKED");
      }
      return { risk: clamp0to100(risk), reasons };
    }

    if (node.type === "DEAL") {
      if (WON_DEAL_STATUSES.has(status)) {
        return { risk: 0, reasons };
      }
      if (status.includes("STALE")) {
        risk += 20;
      }
      risk += dealAmountScale.get(node.id) ?? 0;
      return { risk: clamp0to100(risk), reasons };
    }

    if (node.type === "INCIDENT") {
      if (status === "OPEN" || status === "ACKNOWLEDGED") {
        risk += 70;
        reasons.push("INCIDENT_OPEN");
      }
      return { risk: clamp0to100(risk), reasons };
    }

    return { risk: 0, reasons };
  }

  private toDriver(node: GraphNodeLite, state: NodeRiskState | undefined): RiskDriver {
    const reasons = Array.from(state?.reasons ?? []).sort();

    const counts: Record<string, number> = {};
    if (state) {
      for (const [sourceType, value] of state.incomingByType.entries()) {
        counts[sourceType] = Math.round(value);
      }
    }

    return {
      nodeId: node.id,
      entityId: node.entityId,
      type: node.type,
      title: node.title,
      riskScore: state?.risk ?? node.riskScore,
      reasonCodes: reasons,
      evidence: {
        ...(node.dueAt ? { dueAt: node.dueAt.toISOString() } : {}),
        ...(typeof node.amountCents === "number" ? { amountCents: node.amountCents } : {}),
        ...(node.status ? { status: node.status } : {}),
        ...(Object.keys(counts).length ? { counts } : {})
      },
      deeplink: this.mapDeeplink(node)
    };
  }

  private mapDeeplink(node: GraphNodeLite): { url: string; label: string } | undefined {
    const map: Record<string, string> = {
      DEAL: `/sales/deals/${node.entityId}`,
      WORK_ITEM: `/ops/work/${node.entityId}`,
      INVOICE: `/finance/invoices/${node.entityId}`,
      COMPANY: `/sales/companies/${node.entityId}`,
      CONTACT: `/sales/contacts/${node.entityId}`,
      INCIDENT: `/incidents/${node.entityId}`
    };

    const url = map[node.type];
    if (!url) {
      return undefined;
    }

    return {
      url,
      label: node.title ?? node.type
    };
  }
}
