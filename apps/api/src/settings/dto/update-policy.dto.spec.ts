import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { UpdatePolicyDto } from "./update-policy.dto";

function makeValidPayload() {
  return {
    lockInvoiceOnSent: true,
    overdueAfterDays: 7,
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
  };
}

describe("UpdatePolicyDto", () => {
  it("fails validation for out-of-range fields", () => {
    const dto = plainToInstance(UpdatePolicyDto, {
      ...makeValidPayload(),
      defaultWorkDueDays: 31,
      staleDealAfterDays: 0,
      leadStaleAfterHours: 721,
      autoLockInvoiceAfterDays: -1
    });

    const errors = validateSync(dto);
    expect(errors.length).toBeGreaterThan(0);
    const fields = errors.map((error) => error.property);
    expect(fields).toContain("defaultWorkDueDays");
    expect(fields).toContain("staleDealAfterDays");
    expect(fields).toContain("leadStaleAfterHours");
    expect(fields).toContain("autoLockInvoiceAfterDays");
  });
});
