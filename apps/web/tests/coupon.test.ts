import { couponFromSearch, rememberCoupon, takeCoupon } from "@/lib/coupon";

describe("coupon from a sign-up link", () => {
  afterEach(() => localStorage.clear());
  it("reads and normalises ?coupon=", () => {
    expect(couponFromSearch("?coupon=first50")).toBe("FIRST50");
    expect(couponFromSearch("?coupon=a b")).toBeNull();
    expect(couponFromSearch("?ref=MEHTA10")).toBeNull();
  });
  it("is kept until the organisation is made, then removed", () => {
    expect(rememberCoupon("?coupon=FIRST50&ref=X")).toBe("FIRST50");
    expect(takeCoupon()).toBe("FIRST50");
    expect(takeCoupon()).toBeNull();
  });
});
