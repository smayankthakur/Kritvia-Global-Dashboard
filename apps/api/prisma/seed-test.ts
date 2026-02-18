import {
  DealStage,
  InvoiceStatus,
  PrismaClient,
  Role
} from "@prisma/client";
import { hash } from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";

const prisma = new PrismaClient();
const TEST_PASSWORD = "kritviyaTest123!";

const IDS = {
  orgA: "10000000-0000-0000-0000-000000000001",
  orgB: "20000000-0000-0000-0000-000000000001",
  companyA: "10000000-0000-0000-0000-000000000010",
  dealA: "10000000-0000-0000-0000-000000000020",
  invoiceA: "10000000-0000-0000-0000-000000000030",
  users: {
    adminA: "10000000-0000-0000-0000-000000000101",
    ceoA: "10000000-0000-0000-0000-000000000102",
    opsA: "10000000-0000-0000-0000-000000000103",
    salesA: "10000000-0000-0000-0000-000000000104",
    financeA: "10000000-0000-0000-0000-000000000105",
    adminB: "20000000-0000-0000-0000-000000000101"
  }
} as const;

type FixTemplateSeed = {
  key: string;
  title: string;
  description: string;
  requiresConfirmation: boolean;
  allowedRoles: Role[];
};

const DEFAULT_FIX_TEMPLATES: FixTemplateSeed[] = [
  {
    key: "SEND_INVOICE_REMINDER",
    title: "Send invoice reminder",
    description: "Send a payment reminder for an unpaid invoice.",
    requiresConfirmation: true,
    allowedRoles: [Role.FINANCE, Role.ADMIN, Role.CEO]
  },
  {
    key: "REASSIGN_WORK",
    title: "Reassign work owner",
    description: "Move ownership of a work item to another active teammate.",
    requiresConfirmation: true,
    allowedRoles: [Role.OPS, Role.ADMIN, Role.CEO]
  },
  {
    key: "SET_DUE_DATE",
    title: "Set due date",
    description: "Update due date for work or invoice execution follow-up.",
    requiresConfirmation: true,
    allowedRoles: [Role.OPS, Role.FINANCE, Role.ADMIN, Role.CEO]
  },
  {
    key: "ESCALATE_INCIDENT",
    title: "Escalate incident",
    description: "Escalate an active incident to on-call responders.",
    requiresConfirmation: false,
    allowedRoles: [Role.OPS, Role.ADMIN, Role.CEO]
  }
];

async function seedFixActionTemplates(orgId: string): Promise<void> {
  for (const template of DEFAULT_FIX_TEMPLATES) {
    await prisma.fixActionTemplate.upsert({
      where: {
        orgId_key: {
          orgId,
          key: template.key
        }
      },
      update: {
        title: template.title,
        description: template.description,
        requiresConfirmation: template.requiresConfirmation,
        allowedRoles: template.allowedRoles
      },
      create: {
        orgId,
        key: template.key,
        title: template.title,
        description: template.description,
        requiresConfirmation: template.requiresConfirmation,
        allowedRoles: template.allowedRoles
      }
    });
  }
}

async function upsertUser(input: {
  id: string;
  orgId: string;
  name: string;
  email: string;
  role: Role;
  passwordHash: string;
}): Promise<void> {
  const user = await prisma.user.upsert({
    where: { email: input.email },
    update: {
      id: input.id,
      orgId: input.orgId,
      name: input.name,
      role: input.role,
      isActive: true,
      passwordHash: input.passwordHash
    },
    create: {
      id: input.id,
      orgId: input.orgId,
      name: input.name,
      email: input.email,
      role: input.role,
      isActive: true,
      passwordHash: input.passwordHash
    }
  });

  await prisma.orgMember.upsert({
    where: {
      orgId_email: {
        orgId: input.orgId,
        email: input.email.toLowerCase()
      }
    },
    update: {
      userId: user.id,
      role: input.role,
      status: "ACTIVE",
      joinedAt: user.createdAt
    },
    create: {
      orgId: input.orgId,
      userId: user.id,
      email: input.email.toLowerCase(),
      role: input.role,
      status: "ACTIVE",
      joinedAt: user.createdAt
    }
  });

  const seededApiToken = `ktv_live_seed_${randomBytes(16).toString("hex")}`;
  const seededApiTokenHash = createHash("sha256").update(seededApiToken).digest("hex");
  await prisma.apiToken.upsert({
    where: { tokenHash: seededApiTokenHash },
    update: {
      orgId: IDS.orgA,
      name: "Seeded Public API Token",
      role: Role.ADMIN,
      scopes: ["read:deals", "read:invoices", "read:users"]
    },
    create: {
      orgId: IDS.orgA,
      name: "Seeded Public API Token",
      role: Role.ADMIN,
      tokenHash: seededApiTokenHash,
      scopes: ["read:deals", "read:invoices", "read:users"]
    }
  });

  await prisma.webhookEndpoint.upsert({
    where: { id: "10000000-0000-0000-0000-000000000901" },
    update: {
      orgId: IDS.orgA,
      url: "https://example.test/seed-webhook",
      secret: "seed-test-secret",
      events: ["deal.created", "invoice.status_changed"],
      isActive: true,
      failureCount: 0
    },
    create: {
      id: "10000000-0000-0000-0000-000000000901",
      orgId: IDS.orgA,
      url: "https://example.test/seed-webhook",
      secret: "seed-test-secret",
      events: ["deal.created", "invoice.status_changed"],
      isActive: true,
      failureCount: 0
    }
  });

  const inviteRawToken = `seed-invite-${randomBytes(16).toString("hex")}`;
  const inviteTokenHash = createHash("sha256").update(inviteRawToken).digest("hex");
  await prisma.orgInviteToken.upsert({
    where: { id: "10000000-0000-0000-0000-000000000902" },
    update: {
      orgId: IDS.orgA,
      email: "seed.invite@test.kritviya.local",
      role: Role.OPS,
      tokenHash: inviteTokenHash,
      invitedByUserId: IDS.users.adminA,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      usedAt: null
    },
    create: {
      id: "10000000-0000-0000-0000-000000000902",
      orgId: IDS.orgA,
      email: "seed.invite@test.kritviya.local",
      role: Role.OPS,
      tokenHash: inviteTokenHash,
      invitedByUserId: IDS.users.adminA,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000)
    }
  });
}

async function main(): Promise<void> {
  const passwordHash = await hash(TEST_PASSWORD, 10);

  const plans = {
    starter: await prisma.plan.upsert({
      where: { key: "starter" },
      update: {
        name: "Starter",
        priceMonthly: 1999,
        seatLimit: 5,
        orgLimit: 1,
        autopilotEnabled: false,
        shieldEnabled: false,
        portfolioEnabled: false,
        revenueIntelligenceEnabled: false,
        enterpriseControlsEnabled: false,
        developerPlatformEnabled: false,
        maxWorkItems: null,
        maxInvoices: null
      },
      create: {
        key: "starter",
        name: "Starter",
        priceMonthly: 1999,
        seatLimit: 5,
        orgLimit: 1,
        autopilotEnabled: false,
        shieldEnabled: false,
        portfolioEnabled: false,
        revenueIntelligenceEnabled: false,
        enterpriseControlsEnabled: false,
        developerPlatformEnabled: false
      }
    }),
    growth: await prisma.plan.upsert({
      where: { key: "growth" },
      update: {
        name: "Growth",
        priceMonthly: 4999,
        seatLimit: 15,
        orgLimit: 1,
        autopilotEnabled: true,
        shieldEnabled: true,
        portfolioEnabled: false,
        revenueIntelligenceEnabled: true,
        enterpriseControlsEnabled: false,
        developerPlatformEnabled: false,
        maxWorkItems: null,
        maxInvoices: null
      },
      create: {
        key: "growth",
        name: "Growth",
        priceMonthly: 4999,
        seatLimit: 15,
        orgLimit: 1,
        autopilotEnabled: true,
        shieldEnabled: true,
        portfolioEnabled: false,
        revenueIntelligenceEnabled: true,
        enterpriseControlsEnabled: false,
        developerPlatformEnabled: false
      }
    }),
    pro: await prisma.plan.upsert({
      where: { key: "pro" },
      update: {
        name: "Pro",
        priceMonthly: 9999,
        seatLimit: 50,
        orgLimit: 3,
        autopilotEnabled: true,
        shieldEnabled: true,
        portfolioEnabled: true,
        revenueIntelligenceEnabled: true,
        enterpriseControlsEnabled: false,
        developerPlatformEnabled: true,
        maxWorkItems: null,
        maxInvoices: null
      },
      create: {
        key: "pro",
        name: "Pro",
        priceMonthly: 9999,
        seatLimit: 50,
        orgLimit: 3,
        autopilotEnabled: true,
        shieldEnabled: true,
        portfolioEnabled: true,
        revenueIntelligenceEnabled: true,
        enterpriseControlsEnabled: false,
        developerPlatformEnabled: true
      }
    }),
    enterprise: await prisma.plan.upsert({
      where: { key: "enterprise" },
      update: {
        name: "Enterprise",
        priceMonthly: 0,
        seatLimit: null,
        orgLimit: null,
        autopilotEnabled: true,
        shieldEnabled: true,
        portfolioEnabled: true,
        revenueIntelligenceEnabled: true,
        enterpriseControlsEnabled: true,
        developerPlatformEnabled: true,
        maxWorkItems: null,
        maxInvoices: null
      },
      create: {
        key: "enterprise",
        name: "Enterprise",
        priceMonthly: 0,
        seatLimit: null,
        orgLimit: null,
        autopilotEnabled: true,
        shieldEnabled: true,
        portfolioEnabled: true,
        revenueIntelligenceEnabled: true,
        enterpriseControlsEnabled: true,
        developerPlatformEnabled: true
      }
    })
  };

  const marketplaceApps = [
    {
      key: "slack",
      name: "Slack Alerts",
      description: "Send execution alerts into Slack channels.",
      category: "Messaging",
      oauthProvider: "slack",
      scopes: ["read:insights", "read:actions"],
      webhookEvents: ["ai.action.executed"]
    },
    {
      key: "zapier",
      name: "Zapier Connector",
      description: "Trigger no-code automations from Kritviya events.",
      category: "Ops",
      scopes: ["read:deals", "read:invoices"],
      webhookEvents: ["deal.updated", "invoice.paid"]
    },
    {
      key: "google-sheets",
      name: "Google Sheets Sync",
      description: "Sync pipeline and collections data to Google Sheets.",
      category: "Analytics",
      oauthProvider: "google",
      scopes: ["read:deals", "read:invoices"],
      webhookEvents: ["invoice.paid"]
    },
    {
      key: "kritviya-reporter",
      name: "Kritviya Reporter",
      description: "Generate and share daily execution digests.",
      category: "Analytics",
      scopes: ["read:audit"],
      webhookEvents: ["daily.brief.generated"]
    }
  ];

  for (const app of marketplaceApps) {
    await prisma.marketplaceApp.upsert({
      where: { key: app.key },
      update: {
        name: app.name,
        description: app.description,
        category: app.category,
        oauthProvider: app.oauthProvider ?? null,
        scopes: app.scopes,
        webhookEvents: app.webhookEvents,
        isPublished: true
      },
      create: {
        key: app.key,
        name: app.name,
        description: app.description,
        category: app.category,
        oauthProvider: app.oauthProvider ?? null,
        scopes: app.scopes,
        webhookEvents: app.webhookEvents,
        isPublished: true
      }
    });
  }

  await prisma.marketplaceApp.upsert({
    where: { key: "internal-hidden-test" },
    update: {
      name: "Internal Hidden Test App",
      description: "Non-published app fixture for test filtering.",
      category: "Ops",
      isPublished: false
    },
    create: {
      key: "internal-hidden-test",
      name: "Internal Hidden Test App",
      description: "Non-published app fixture for test filtering.",
      category: "Ops",
      isPublished: false
    }
  });

  await prisma.org.upsert({
    where: { id: IDS.orgA },
    update: { name: "Test Org A", slug: "test-org-a", statusEnabled: true, statusName: "Test Org A Status" },
    create: { id: IDS.orgA, name: "Test Org A", slug: "test-org-a", statusEnabled: true, statusName: "Test Org A Status" }
  });

  await prisma.org.upsert({
    where: { id: IDS.orgB },
    update: { name: "Test Org B", slug: "test-org-b", statusEnabled: false },
    create: { id: IDS.orgB, name: "Test Org B", slug: "test-org-b", statusEnabled: false }
  });

  await prisma.policy.upsert({
    where: { orgId: IDS.orgA },
    update: {
      lockInvoiceOnSent: true,
      overdueAfterDays: 0,
      defaultWorkDueDays: 3,
      staleDealAfterDays: 7,
      leadStaleAfterHours: 72,
      requireDealOwner: true,
      requireWorkOwner: true,
      requireWorkDueDate: true,
      autoLockInvoiceAfterDays: 2,
      preventInvoiceUnlockAfterPartialPayment: true,
      autopilotEnabled: false,
      autopilotCreateWorkOnDealStageChange: true,
      autopilotNudgeOnOverdue: true,
      autopilotAutoStaleDeals: true,
      auditRetentionDays: 180,
      securityEventRetentionDays: 180,
      ipAllowlist: [],
      ipRestrictionEnabled: false
    },
    create: {
      orgId: IDS.orgA,
      lockInvoiceOnSent: true,
      overdueAfterDays: 0,
      defaultWorkDueDays: 3,
      staleDealAfterDays: 7,
      leadStaleAfterHours: 72,
      requireDealOwner: true,
      requireWorkOwner: true,
      requireWorkDueDate: true,
      autoLockInvoiceAfterDays: 2,
      preventInvoiceUnlockAfterPartialPayment: true,
      autopilotEnabled: false,
      autopilotCreateWorkOnDealStageChange: true,
      autopilotNudgeOnOverdue: true,
      autopilotAutoStaleDeals: true,
      auditRetentionDays: 180,
      securityEventRetentionDays: 180,
      ipAllowlist: [],
      ipRestrictionEnabled: false
    }
  });

  await prisma.subscription.upsert({
    where: { orgId: IDS.orgA },
    update: { planId: plans.pro.id, status: "ACTIVE" },
    create: { orgId: IDS.orgA, planId: plans.pro.id, status: "ACTIVE" }
  });

  await prisma.subscription.upsert({
    where: { orgId: IDS.orgB },
    update: { planId: plans.pro.id, status: "ACTIVE" },
    create: { orgId: IDS.orgB, planId: plans.pro.id, status: "ACTIVE" }
  });

  await prisma.policy.upsert({
    where: { orgId: IDS.orgB },
    update: {
      lockInvoiceOnSent: true,
      overdueAfterDays: 0,
      defaultWorkDueDays: 3,
      staleDealAfterDays: 7,
      leadStaleAfterHours: 72,
      requireDealOwner: true,
      requireWorkOwner: true,
      requireWorkDueDate: true,
      autoLockInvoiceAfterDays: 2,
      preventInvoiceUnlockAfterPartialPayment: true,
      autopilotEnabled: false,
      autopilotCreateWorkOnDealStageChange: true,
      autopilotNudgeOnOverdue: true,
      autopilotAutoStaleDeals: true,
      auditRetentionDays: 180,
      securityEventRetentionDays: 180,
      ipAllowlist: [],
      ipRestrictionEnabled: false
    },
    create: {
      orgId: IDS.orgB,
      lockInvoiceOnSent: true,
      overdueAfterDays: 0,
      defaultWorkDueDays: 3,
      staleDealAfterDays: 7,
      leadStaleAfterHours: 72,
      requireDealOwner: true,
      requireWorkOwner: true,
      requireWorkDueDate: true,
      autoLockInvoiceAfterDays: 2,
      preventInvoiceUnlockAfterPartialPayment: true,
      autopilotEnabled: false,
      autopilotCreateWorkOnDealStageChange: true,
      autopilotNudgeOnOverdue: true,
      autopilotAutoStaleDeals: true,
      auditRetentionDays: 180,
      securityEventRetentionDays: 180,
      ipAllowlist: [],
      ipRestrictionEnabled: false
    }
  });

  await upsertUser({
    id: IDS.users.adminA,
    orgId: IDS.orgA,
    name: "Admin A",
    email: "admina@test.kritviya.local",
    role: Role.ADMIN,
    passwordHash
  });
  await upsertUser({
    id: IDS.users.ceoA,
    orgId: IDS.orgA,
    name: "CEO A",
    email: "ceoa@test.kritviya.local",
    role: Role.CEO,
    passwordHash
  });
  await upsertUser({
    id: IDS.users.opsA,
    orgId: IDS.orgA,
    name: "Ops A",
    email: "opsa@test.kritviya.local",
    role: Role.OPS,
    passwordHash
  });
  await upsertUser({
    id: IDS.users.salesA,
    orgId: IDS.orgA,
    name: "Sales A",
    email: "salesa@test.kritviya.local",
    role: Role.SALES,
    passwordHash
  });
  await upsertUser({
    id: IDS.users.financeA,
    orgId: IDS.orgA,
    name: "Finance A",
    email: "financea@test.kritviya.local",
    role: Role.FINANCE,
    passwordHash
  });
  await upsertUser({
    id: IDS.users.adminB,
    orgId: IDS.orgB,
    name: "Admin B",
    email: "adminb@test.kritviya.local",
    role: Role.ADMIN,
    passwordHash
  });

  await prisma.orgMember.upsert({
    where: {
      orgId_email: {
        orgId: IDS.orgB,
        email: "admina@test.kritviya.local"
      }
    },
    update: {
      userId: IDS.users.adminA,
      role: Role.ADMIN,
      status: "ACTIVE"
    },
    create: {
      orgId: IDS.orgB,
      userId: IDS.users.adminA,
      email: "admina@test.kritviya.local",
      role: Role.ADMIN,
      status: "ACTIVE",
      joinedAt: new Date()
    }
  });

  await prisma.company.upsert({
    where: { id: IDS.companyA },
    update: {
      orgId: IDS.orgA,
      name: "Company A",
      industry: "Software",
      ownerUserId: IDS.users.salesA
    },
    create: {
      id: IDS.companyA,
      orgId: IDS.orgA,
      name: "Company A",
      industry: "Software",
      ownerUserId: IDS.users.salesA
    }
  });

  await prisma.deal.upsert({
    where: { id: IDS.dealA },
    update: {
      orgId: IDS.orgA,
      title: "Deal A",
      stage: DealStage.OPEN,
      companyId: IDS.companyA,
      ownerUserId: IDS.users.salesA,
      valueAmount: 100000,
      currency: "INR",
      wonAt: null
    },
    create: {
      id: IDS.dealA,
      orgId: IDS.orgA,
      title: "Deal A",
      stage: DealStage.OPEN,
      companyId: IDS.companyA,
      ownerUserId: IDS.users.salesA,
      valueAmount: 100000,
      currency: "INR"
    }
  });

  await prisma.invoice.upsert({
    where: { id: IDS.invoiceA },
    update: {
      orgId: IDS.orgA,
      invoiceNumber: "TEST-INV-001",
      companyId: IDS.companyA,
      dealId: IDS.dealA,
      status: InvoiceStatus.DRAFT,
      amount: 10000,
      currency: "INR",
      issueDate: new Date("2026-01-01"),
      dueDate: new Date("2026-01-20"),
      lockedAt: null,
      lockedByUserId: null,
      createdByUserId: IDS.users.financeA
    },
    create: {
      id: IDS.invoiceA,
      orgId: IDS.orgA,
      invoiceNumber: "TEST-INV-001",
      companyId: IDS.companyA,
      dealId: IDS.dealA,
      status: InvoiceStatus.DRAFT,
      amount: 10000,
      currency: "INR",
      issueDate: new Date("2026-01-01"),
      dueDate: new Date("2026-01-20"),
      createdByUserId: IDS.users.financeA
    }
  });

  await prisma.workItem.deleteMany({
    where: {
      orgId: IDS.orgA,
      dealId: IDS.dealA
    }
  });

  await seedFixActionTemplates(IDS.orgA);
  await seedFixActionTemplates(IDS.orgB);

  console.log("Test seed complete.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
