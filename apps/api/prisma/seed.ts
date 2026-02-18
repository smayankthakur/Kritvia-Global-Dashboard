import { PrismaClient, Role } from "@prisma/client";
import { hash } from "bcryptjs";

const prisma = new PrismaClient();
const DEMO_PASSWORD = "kritviya123";

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

async function main(): Promise<void> {
  const passwordHash = await hash(DEMO_PASSWORD, 10);

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

  const org = await prisma.org.upsert({
    where: { id: "00000000-0000-0000-0000-000000000001" },
    update: {
      name: "Demo Org",
      slug: "demo-org",
      statusEnabled: true,
      statusName: "Demo Org Status",
      statusVisibility: "PUBLIC"
    },
    create: {
      id: "00000000-0000-0000-0000-000000000001",
      name: "Demo Org",
      slug: "demo-org",
      statusEnabled: true,
      statusName: "Demo Org Status",
      statusVisibility: "PUBLIC"
    }
  });

  await prisma.policy.upsert({
    where: { orgId: org.id },
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
      orgId: org.id,
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
    where: { orgId: org.id },
    update: {
      planId: plans.pro.id,
      status: "ACTIVE"
    },
    create: {
      orgId: org.id,
      planId: plans.pro.id,
      status: "ACTIVE"
    }
  });

  const statusComponents = [
    { key: "api", name: "API", description: "Core API request handling" },
    { key: "web", name: "Web App", description: "Dashboard web frontend availability" },
    { key: "db", name: "Database", description: "Primary Postgres availability" },
    { key: "webhooks", name: "Webhooks", description: "Outbound webhook delivery pipeline" },
    { key: "ai", name: "AI", description: "AI insight/action and LLM services" },
    { key: "billing", name: "Billing", description: "Subscription and payment integrations" }
  ];

  for (const component of statusComponents) {
    await prisma.statusComponent.upsert({
      where: {
        orgId_key: {
          orgId: org.id,
          key: component.key
        }
      },
      update: {
        name: component.name,
        description: component.description
      },
      create: {
        orgId: org.id,
        key: component.key,
        name: component.name,
        description: component.description
      }
    });
  }

  const demoUsers: Array<{ name: string; email: string; role: Role }> = [
    { name: "Demo CEO", email: "ceo@demo.kritviya.local", role: Role.CEO },
    { name: "Demo Ops", email: "ops@demo.kritviya.local", role: Role.OPS },
    { name: "Demo Sales", email: "sales@demo.kritviya.local", role: Role.SALES },
    { name: "Demo Finance", email: "finance@demo.kritviya.local", role: Role.FINANCE },
    { name: "Demo Admin", email: "admin@demo.kritviya.local", role: Role.ADMIN }
  ];

  for (const demoUser of demoUsers) {
    const user = await prisma.user.upsert({
      where: { email: demoUser.email },
      update: {
        orgId: org.id,
        name: demoUser.name,
        role: demoUser.role,
        isActive: true,
        passwordHash
      },
      create: {
        orgId: org.id,
        name: demoUser.name,
        email: demoUser.email,
        role: demoUser.role,
        isActive: true,
        passwordHash
      }
    });

    await prisma.orgMember.upsert({
      where: {
        orgId_email: {
          orgId: org.id,
          email: demoUser.email
        }
      },
      update: {
        userId: user.id,
        role: demoUser.role,
        status: "ACTIVE",
        joinedAt: user.createdAt
      },
      create: {
        orgId: org.id,
        userId: user.id,
        email: demoUser.email,
        role: demoUser.role,
        status: "ACTIVE",
        joinedAt: user.createdAt
      }
    });
  }

  await seedFixActionTemplates(org.id);

  console.log("Seed complete: Demo Org and 5 role users created/updated.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
