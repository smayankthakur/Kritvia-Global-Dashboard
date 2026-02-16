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
        enterpriseControlsEnabled: false
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
        enterpriseControlsEnabled: false
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
        enterpriseControlsEnabled: false
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
        enterpriseControlsEnabled: true
      }
    })
  };

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
