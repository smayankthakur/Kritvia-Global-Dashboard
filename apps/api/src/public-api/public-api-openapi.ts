type OpenApiDoc = Record<string, unknown>;

function paginatedResponseSchema(itemSchemaRef: string): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          $ref: itemSchemaRef
        }
      },
      page: { type: "integer", example: 1 },
      pageSize: { type: "integer", example: 20 },
      totalCount: { type: "integer", example: 120 },
      total: { type: "integer", example: 120 }
    }
  };
}

function listOperation(scope: string, summary: string, schemaRef: string): Record<string, unknown> {
  return {
    summary,
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: "page",
        in: "query",
        schema: { type: "integer", minimum: 1, default: 1 }
      },
      {
        name: "pageSize",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 100, default: 20 }
      },
      {
        name: "sortBy",
        in: "query",
        schema: { type: "string" }
      },
      {
        name: "sortDir",
        in: "query",
        schema: { type: "string", enum: ["asc", "desc"], default: "desc" }
      }
    ],
    responses: {
      200: {
        description: "Success",
        headers: {
          "X-Kritviya-Version": {
            schema: { type: "string", example: "1" }
          }
        },
        content: {
          "application/json": {
            schema: paginatedResponseSchema(schemaRef)
          }
        }
      },
      401: {
        description: "Unauthorized"
      },
      403: {
        description: "Forbidden (missing service-account scope)"
      }
    },
    "x-kritviya-required-scope": scope
  };
}

export function buildPublicApiOpenApiDocument(baseUrl?: string): OpenApiDoc {
  const serverUrl = baseUrl || "https://api.example.com";

  return {
    openapi: "3.0.3",
    info: {
      title: "Kritviya Public API",
      version: "1.0.0",
      description: "Service-account scoped Public API (v1)."
    },
    servers: [
      {
        url: serverUrl
      }
    ],
    tags: [{ name: "public" }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "API Token"
        }
      },
      schemas: {
        User: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            email: { type: "string" },
            role: { type: "string" },
            isActive: { type: "boolean" },
            createdAt: { type: "string", format: "date-time" }
          }
        },
        Deal: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            title: { type: "string" },
            stage: { type: "string" },
            valueAmount: { type: "number" },
            currency: { type: "string" },
            createdAt: { type: "string", format: "date-time" }
          }
        },
        Invoice: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            invoiceNumber: { type: "string", nullable: true },
            status: { type: "string" },
            amount: { type: "number" },
            currency: { type: "string" },
            dueDate: { type: "string", format: "date-time" },
            createdAt: { type: "string", format: "date-time" }
          }
        },
        WorkItem: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            title: { type: "string" },
            status: { type: "string" },
            priority: { type: "integer" },
            dueDate: { type: "string", format: "date-time", nullable: true },
            createdAt: { type: "string", format: "date-time" }
          }
        },
        Insight: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            type: { type: "string" },
            severity: { type: "string" },
            scoreImpact: { type: "integer" },
            title: { type: "string" },
            explanation: { type: "string" },
            createdAt: { type: "string", format: "date-time" }
          }
        },
        Action: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            type: { type: "string" },
            status: { type: "string" },
            title: { type: "string" },
            rationale: { type: "string" },
            createdAt: { type: "string", format: "date-time" }
          }
        }
      }
    },
    paths: {
      "/api/v1/openapi.json": {
        get: {
          summary: "Get OpenAPI for public API v1",
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: "OpenAPI JSON",
              headers: {
                "X-Kritviya-Version": {
                  schema: { type: "string", example: "1" }
                }
              },
              content: {
                "application/json": {
                  schema: { type: "object", additionalProperties: true }
                }
              }
            },
            401: { description: "Unauthorized" },
            403: { description: "Forbidden (missing read:docs scope)" }
          },
          "x-kritviya-required-scope": "read:docs"
        }
      },
      "/api/v1/users": {
        get: listOperation("read:users", "List users", "#/components/schemas/User")
      },
      "/api/v1/deals": {
        get: listOperation("read:deals", "List deals", "#/components/schemas/Deal")
      },
      "/api/v1/invoices": {
        get: listOperation("read:invoices", "List invoices", "#/components/schemas/Invoice")
      },
      "/api/v1/work-items": {
        get: listOperation("read:work-items", "List work items", "#/components/schemas/WorkItem")
      },
      "/api/v1/insights": {
        get: listOperation("read:insights", "List insights", "#/components/schemas/Insight")
      },
      "/api/v1/actions": {
        get: listOperation("read:actions", "List actions", "#/components/schemas/Action")
      }
    }
  };
}
