/* eslint-disable @typescript-eslint/no-require-imports */
const { PrismaClient, Role } = require("@prisma/client");
const { hash } = require("bcryptjs");

const prisma = new PrismaClient();
const DEMO_PASSWORD = "kritviya123";

async function main() {
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
    update: { name: "Demo Org" },
    create: {
      id: "00000000-0000-0000-0000-000000000001",
      name: "Demo Org"
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

  const defaultAlertRules = [
    {
      type: "JOB_FAILURE_SPIKE",
      thresholdCount: 5,
      windowMinutes: 10,
      severity: "HIGH",
      autoMitigation: null
    },
    {
      type: "WEBHOOK_FAILURE_SPIKE",
      thresholdCount: 10,
      windowMinutes: 10,
      severity: "HIGH",
      autoMitigation: { action: "DISABLE_WEBHOOK" }
    },
    {
      type: "APP_COMMAND_FAILURE_SPIKE",
      thresholdCount: 20,
      windowMinutes: 10,
      severity: "CRITICAL",
      autoMitigation: { action: "PAUSE_APP_INSTALL" }
    },
    {
      type: "OAUTH_REFRESH_FAILURE",
      thresholdCount: 5,
      windowMinutes: 60,
      severity: "HIGH",
      autoMitigation: { action: "OPEN_CIRCUIT" }
    }
  ];

  for (const rule of defaultAlertRules) {
    const existingRule = await prisma.alertRule.findFirst({
      where: {
        orgId: org.id,
        type: rule.type
      },
      select: { id: true }
    });

    if (existingRule) {
      await prisma.alertRule.update({
        where: { id: existingRule.id },
        data: {
          isEnabled: true,
          thresholdCount: rule.thresholdCount,
          windowMinutes: rule.windowMinutes,
          severity: rule.severity,
          autoCreateIncident: false,
          autoMitigation: rule.autoMitigation ?? undefined
        }
      });
      continue;
    }

    await prisma.alertRule.create({
      data: {
        orgId: org.id,
        type: rule.type,
        isEnabled: true,
        thresholdCount: rule.thresholdCount,
        windowMinutes: rule.windowMinutes,
        severity: rule.severity,
        autoCreateIncident: false,
        autoMitigation: rule.autoMitigation ?? undefined
      }
    });
  }

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
      where: { key: component.key },
      update: {
        orgId: org.id,
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

  await prisma.escalationPolicy.upsert({
    where: {
      orgId: org.id
    },
    update: {
      name: "Default escalation policy",
      isEnabled: true,
      timezone: "UTC",
      quietHoursEnabled: false,
      quietHoursStart: "22:00",
      quietHoursEnd: "08:00",
      businessDaysOnly: false,
      slaCritical: 10,
      slaHigh: 30,
      slaMedium: 180,
      slaLow: 1440,
      steps: [
        { afterMinutes: 10, routeTo: ["SLACK"], minSeverity: "CRITICAL" },
        { afterMinutes: 30, routeTo: ["EMAIL", "WEBHOOK"], minSeverity: "HIGH" },
        { afterMinutes: 180, routeTo: ["EMAIL"], minSeverity: "MEDIUM" }
      ]
    },
    create: {
      orgId: org.id,
      name: "Default escalation policy",
      isEnabled: true,
      timezone: "UTC",
      quietHoursEnabled: false,
      quietHoursStart: "22:00",
      quietHoursEnd: "08:00",
      businessDaysOnly: false,
      slaCritical: 10,
      slaHigh: 30,
      slaMedium: 180,
      slaLow: 1440,
      steps: [
        { afterMinutes: 10, routeTo: ["SLACK"], minSeverity: "CRITICAL" },
        { afterMinutes: 30, routeTo: ["EMAIL", "WEBHOOK"], minSeverity: "HIGH" },
        { afterMinutes: 180, routeTo: ["EMAIL"], minSeverity: "MEDIUM" }
      ]
    }
  });

  const demoUsers = [
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

  const seededUsers = await prisma.user.findMany({
    where: {
      orgId: org.id,
      email: {
        in: demoUsers.map((entry) => entry.email)
      }
    },
    select: {
      id: true,
      email: true
    }
  });
  const userByEmail = new Map(seededUsers.map((entry) => [entry.email, entry.id]));

  const existingOnCallSchedule = await prisma.onCallSchedule.findFirst({
    where: { orgId: org.id },
    orderBy: { createdAt: "asc" }
  });
  const onCallSchedule = existingOnCallSchedule
    ? await prisma.onCallSchedule.update({
        where: { id: existingOnCallSchedule.id },
        data: {
          name: "Default On-call",
          timezone: "UTC",
          handoffInterval: "WEEKLY",
          handoffHour: 10,
          isEnabled: true
        }
      })
    : await prisma.onCallSchedule.create({
        data: {
          orgId: org.id,
          name: "Default On-call",
          timezone: "UTC",
          handoffInterval: "WEEKLY",
          handoffHour: 10,
          isEnabled: true
        }
      });

  const primaryUserId = userByEmail.get("ceo@demo.kritviya.local") ?? userByEmail.get("admin@demo.kritviya.local");
  const secondaryUserId = userByEmail.get("admin@demo.kritviya.local") ?? userByEmail.get("ops@demo.kritviya.local");

  if (primaryUserId) {
    await prisma.onCallRotationMember.upsert({
      where: {
        scheduleId_tier_order: {
          scheduleId: onCallSchedule.id,
          tier: "PRIMARY",
          order: 1
        }
      },
      update: {
        userId: primaryUserId,
        isActive: true
      },
      create: {
        scheduleId: onCallSchedule.id,
        userId: primaryUserId,
        tier: "PRIMARY",
        order: 1,
        isActive: true
      }
    });
  }

  if (secondaryUserId) {
    await prisma.onCallRotationMember.upsert({
      where: {
        scheduleId_tier_order: {
          scheduleId: onCallSchedule.id,
          tier: "SECONDARY",
          order: 1
        }
      },
      update: {
        userId: secondaryUserId,
        isActive: true
      },
      create: {
        scheduleId: onCallSchedule.id,
        userId: secondaryUserId,
        tier: "SECONDARY",
        order: 1,
        isActive: true
      }
    });
  }

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
