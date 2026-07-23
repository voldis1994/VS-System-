import { describe, expect, it } from "vitest";
import { Role } from "./enums";
import { hasPermission, permissionsForRole } from "./rbac";

describe("rbac", () => {
  it("owner has live trading permission", () => {
    expect(hasPermission(Role.OWNER, "accounts:live")).toBe(true);
  });

  it("viewer cannot place orders", () => {
    expect(hasPermission(Role.VIEWER, "orders:place")).toBe(false);
  });

  it("risk manager can lock accounts", () => {
    expect(permissionsForRole(Role.RISK_MANAGER)).toContain("accounts:lock");
  });
});
