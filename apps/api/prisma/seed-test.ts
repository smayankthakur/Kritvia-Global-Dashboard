import {
  DealStage,
  InvoiceStatus,
  PrismaClient,
  Role
} from "@prisma/client";
import { hash } from "bcryptjs";

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

async function upsertUser(input: {
  id: string;
  orgId: string;
  name: string;
  email: string;
  role: Role;
  passwordHash: string;
}): Promise<void> {
  await prisma.user.upsert({
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
}

async function main(): Promise<void> {
  const passwordHash = await hash(TEST_PASSWORD, 10);

  await prisma.org.upsert({
    where: { id: IDS.orgA },
    update: { name: "Test Org A" },
    create: { id: IDS.orgA, name: "Test Org A" }
  });

  await prisma.org.upsert({
    where: { id: IDS.orgB },
    update: { name: "Test Org B" },
    create: { id: IDS.orgB, name: "Test Org B" }
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
      autopilotAutoStaleDeals: true
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
      autopilotAutoStaleDeals: true
    }
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
      autopilotAutoStaleDeals: true
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
      autopilotAutoStaleDeals: true
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
