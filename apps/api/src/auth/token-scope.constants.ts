export const KNOWN_API_TOKEN_SCOPES = [
  "read:users",
  "read:deals",
  "read:invoices",
  "read:work-items",
  "read:insights",
  "read:actions",
  "write:invoices",
  "read:audit"
] as const;

export type ApiTokenScope = (typeof KNOWN_API_TOKEN_SCOPES)[number];
