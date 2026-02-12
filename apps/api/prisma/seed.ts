import { PrismaClient, Role } from "@prisma/client";
import { hash } from "bcryptjs";

const prisma = new PrismaClient();
const DEMO_PASSWORD = "kritviya123";

async function main(): Promise<void> {
  const passwordHash = await hash(DEMO_PASSWORD, 10);

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
    update: {},
    create: {
      orgId: org.id,
      lockInvoiceOnSent: true,
      overdueAfterDays: 0
    }
  });

  const demoUsers: Array<{ name: string; email: string; role: Role }> = [
    { name: "Demo CEO", email: "ceo@demo.kritviya.local", role: Role.CEO },
    { name: "Demo Ops", email: "ops@demo.kritviya.local", role: Role.OPS },
    { name: "Demo Sales", email: "sales@demo.kritviya.local", role: Role.SALES },
    { name: "Demo Finance", email: "finance@demo.kritviya.local", role: Role.FINANCE },
    { name: "Demo Admin", email: "admin@demo.kritviya.local", role: Role.ADMIN }
  ];

  for (const demoUser of demoUsers) {
    await prisma.user.upsert({
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
