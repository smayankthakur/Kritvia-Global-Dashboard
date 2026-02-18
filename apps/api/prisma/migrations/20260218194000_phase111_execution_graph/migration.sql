-- Phase 11.1 Execution Graph schema

CREATE TABLE "graph_nodes" (
  "id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "entity_id" TEXT NOT NULL,
  "title" TEXT,
  "status" TEXT,
  "amount_cents" INTEGER,
  "currency" TEXT,
  "due_at" TIMESTAMP(3),
  "occurred_at" TIMESTAMP(3),
  "risk_score" INTEGER NOT NULL DEFAULT 0,
  "meta" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "graph_nodes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "graph_edges" (
  "id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "from_node_id" UUID NOT NULL,
  "to_node_id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "weight" INTEGER NOT NULL DEFAULT 1,
  "meta" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "graph_edges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "graph_nodes_org_id_type_entity_id_key"
  ON "graph_nodes"("org_id", "type", "entity_id");

CREATE INDEX "graph_nodes_org_id_type_updated_at_idx"
  ON "graph_nodes"("org_id", "type", "updated_at");

CREATE INDEX "graph_nodes_org_id_updated_at_idx"
  ON "graph_nodes"("org_id", "updated_at");

CREATE INDEX "graph_nodes_org_id_risk_score_idx"
  ON "graph_nodes"("org_id", "risk_score");

CREATE UNIQUE INDEX "graph_edges_org_id_from_node_id_to_node_id_type_key"
  ON "graph_edges"("org_id", "from_node_id", "to_node_id", "type");

CREATE INDEX "graph_edges_org_id_from_node_id_idx"
  ON "graph_edges"("org_id", "from_node_id");

CREATE INDEX "graph_edges_org_id_to_node_id_idx"
  ON "graph_edges"("org_id", "to_node_id");

CREATE INDEX "graph_edges_org_id_type_created_at_idx"
  ON "graph_edges"("org_id", "type", "created_at");

ALTER TABLE "graph_nodes"
  ADD CONSTRAINT "graph_nodes_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "graph_edges"
  ADD CONSTRAINT "graph_edges_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "graph_edges"
  ADD CONSTRAINT "graph_edges_from_node_id_fkey"
  FOREIGN KEY ("from_node_id") REFERENCES "graph_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "graph_edges"
  ADD CONSTRAINT "graph_edges_to_node_id_fkey"
  FOREIGN KEY ("to_node_id") REFERENCES "graph_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
