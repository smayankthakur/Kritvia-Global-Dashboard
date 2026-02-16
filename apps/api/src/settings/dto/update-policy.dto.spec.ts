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
    autopilotAutoStaleDeals: true,
    auditRetentionDays: 180,
    securityEventRetentionDays: 180,
    ipRestrictionEnabled: false,
    ipAllowlist: []
  };
}

describe("UpdatePolicyDto", () => {
  it("fails validation for out-of-range fields", () => {
    const dto = plainToInstance(UpdatePolicyDto, {
      ...makeValidPayload(),
      defaultWorkDueDays: 31,
      staleDealAfterDays: 0,
      leadStaleAfterHours: 721,
      autoLockInvoiceAfterDays: -1,
      auditRetentionDays: 10,
      securityEventRetentionDays: 4000,
      ipAllowlist: ["bad-ip"]
    });

    const errors = validateSync(dto);
    expect(errors.length).toBeGreaterThan(0);
    const fields = errors.map((error) => error.property);
    expect(fields).toContain("defaultWorkDueDays");
    expect(fields).toContain("staleDealAfterDays");
    expect(fields).toContain("leadStaleAfterHours");
    expect(fields).toContain("autoLockInvoiceAfterDays");
    expect(fields).toContain("auditRetentionDays");
    expect(fields).toContain("securityEventRetentionDays");
  });
});
