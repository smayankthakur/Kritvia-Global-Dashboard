export const KNOWN_API_TOKEN_SCOPES = [
  "read:docs",
  "read:users",
  "read:deals",
  "read:invoices",
  "read:work-items",
  "read:insights",
  "read:actions",
  "write:invoices",
  "read:audit",
  "admin:*"
] as const;

export type ApiTokenScope = (typeof KNOWN_API_TOKEN_SCOPES)[number];
