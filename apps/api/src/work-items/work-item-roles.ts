import { Role } from "@prisma/client";

export const WORK_ITEM_READ_ROLES: Role[] = [Role.OPS, Role.ADMIN, Role.CEO, Role.SALES];
export const WORK_ITEM_WRITE_ROLES: Role[] = [Role.OPS, Role.ADMIN];
