import { Role } from "@prisma/client";

export interface AuthTokenPayload {
  sub: string;
  orgId: string;
  role: Role;
  email: string;
  name: string;
}

export interface AuthUserContext {
  userId: string;
  orgId: string;
  role: Role;
  email: string;
  name: string;
}
