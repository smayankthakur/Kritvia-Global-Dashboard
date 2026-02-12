import { Role } from "@prisma/client";

export const SALES_READ_ROLES: Role[] = [Role.SALES, Role.ADMIN, Role.CEO];
export const SALES_WRITE_ROLES: Role[] = [Role.SALES, Role.ADMIN];
