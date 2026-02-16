import { Injectable } from "@nestjs/common";
import { AuthUserContext } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class DirectoryService {
  constructor(private readonly prisma: PrismaService) {}

  async listUsers(authUser: AuthUserContext) {
    const orgId = authUser.activeOrgId ?? authUser.orgId;
    return this.prisma.user.findMany({
      where: {
        orgId
      },
      select: {
        id: true,
        name: true,
        role: true,
        isActive: true
      },
      orderBy: [{ isActive: "desc" }, { name: "asc" }, { id: "asc" }],
      take: 100
    });
  }
}
