import { Role } from "@prisma/client";

export const INVOICE_READ_ROLES: Role[] = [Role.FINANCE, Role.ADMIN, Role.CEO, Role.SALES];
export const INVOICE_WRITE_ROLES: Role[] = [Role.FINANCE, Role.ADMIN];
