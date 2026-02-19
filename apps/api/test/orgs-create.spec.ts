import { Test } from "@nestjs/testing";
import { Role } from "@prisma/client";
import { ActivityLogService } from "../src/activity-log/activity-log.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { OrgsService } from "../src/orgs/orgs.service";

describe("OrgsService.create", () => {
  it("creates org, membership, and activity log", async () => {
    const prismaMock = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: "user-1",
          email: "owner@example.com",
          isActive: true,
          name: "Owner"
        })
      },
      org: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ id: "existing" })
          .mockResolvedValueOnce(null)
      },
      orgMember: {
        findFirst: jest.fn().mockResolvedValue({ id: "member-1" })
      },
      $transaction: jest.fn().mockImplementation(async (callback: (tx: any) => Promise<any>) => {
        const tx = {
          org: {
            create: jest.fn().mockResolvedValue({
              id: "org-2",
              name: "Acme Org",
              slug: "acme-org-2"
            })
          },
          orgMember: {
            create: jest.fn().mockResolvedValue({
              role: Role.CEO,
              status: "ACTIVE"
            })
          },
          policy: {
            upsert: jest.fn().mockResolvedValue({})
          }
        };
        return callback(tx);
      })
    };

    const activityLogMock = {
      log: jest.fn().mockResolvedValue(undefined)
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrgsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ActivityLogService, useValue: activityLogMock }
      ]
    }).compile();

    const service = moduleRef.get(OrgsService);
    const result = await service.create(
      {
        userId: "user-1",
        orgId: "org-1",
        activeOrgId: "org-1",
        role: Role.ADMIN,
        email: "owner@example.com",
        name: "Owner"
      },
      { name: "Acme Org" }
    );

    expect(result.org.slug).toBe("acme-org-2");
    expect(result.membership.role).toBe(Role.CEO);
    expect(activityLogMock.log).toHaveBeenCalledTimes(1);
    await moduleRef.close();
  });
});
