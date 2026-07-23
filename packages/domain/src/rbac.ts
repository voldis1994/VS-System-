import { Role } from "./enums";

export type Permission =
  | "org:manage"
  | "org:billing"
  | "org:delete"
  | "users:manage"
  | "users:invite"
  | "accounts:read"
  | "accounts:manage"
  | "accounts:connect"
  | "accounts:lock"
  | "accounts:live"
  | "orders:read"
  | "orders:place"
  | "orders:modify"
  | "orders:cancel"
  | "positions:read"
  | "positions:close"
  | "positions:modify"
  | "strategies:read"
  | "strategies:manage"
  | "strategies:run"
  | "copier:read"
  | "copier:manage"
  | "copier:run"
  | "risk:read"
  | "risk:manage"
  | "risk:override"
  | "automations:read"
  | "automations:manage"
  | "automations:run"
  | "alerts:read"
  | "alerts:manage"
  | "analytics:read"
  | "reports:read"
  | "reports:export"
  | "journal:read"
  | "journal:write"
  | "backtest:read"
  | "backtest:run"
  | "audit:read"
  | "integrations:manage"
  | "settings:manage"
  | "security:manage";

const ALL_PERMISSIONS: Permission[] = [
  "org:manage",
  "org:billing",
  "org:delete",
  "users:manage",
  "users:invite",
  "accounts:read",
  "accounts:manage",
  "accounts:connect",
  "accounts:lock",
  "accounts:live",
  "orders:read",
  "orders:place",
  "orders:modify",
  "orders:cancel",
  "positions:read",
  "positions:close",
  "positions:modify",
  "strategies:read",
  "strategies:manage",
  "strategies:run",
  "copier:read",
  "copier:manage",
  "copier:run",
  "risk:read",
  "risk:manage",
  "risk:override",
  "automations:read",
  "automations:manage",
  "automations:run",
  "alerts:read",
  "alerts:manage",
  "analytics:read",
  "reports:read",
  "reports:export",
  "journal:read",
  "journal:write",
  "backtest:read",
  "backtest:run",
  "audit:read",
  "integrations:manage",
  "settings:manage",
  "security:manage",
];

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  [Role.OWNER]: ALL_PERMISSIONS,
  [Role.ADMIN]: ALL_PERMISSIONS.filter(
    (p) => !["org:delete", "org:billing", "security:manage"].includes(p),
  ),
  [Role.TRADER]: [
    "accounts:read",
    "orders:read",
    "orders:place",
    "orders:modify",
    "orders:cancel",
    "positions:read",
    "positions:close",
    "positions:modify",
    "strategies:read",
    "strategies:run",
    "copier:read",
    "copier:run",
    "risk:read",
    "automations:read",
    "alerts:read",
    "analytics:read",
    "reports:read",
    "journal:read",
    "journal:write",
    "backtest:read",
    "backtest:run",
  ],
  [Role.RISK_MANAGER]: [
    "accounts:read",
    "accounts:lock",
    "orders:read",
    "orders:cancel",
    "positions:read",
    "positions:close",
    "positions:modify",
    "strategies:read",
    "strategies:run",
    "copier:read",
    "copier:run",
    "risk:read",
    "risk:manage",
    "risk:override",
    "automations:read",
    "alerts:read",
    "alerts:manage",
    "analytics:read",
    "reports:read",
    "reports:export",
    "audit:read",
  ],
  [Role.ANALYST]: [
    "accounts:read",
    "orders:read",
    "positions:read",
    "strategies:read",
    "risk:read",
    "analytics:read",
    "reports:read",
    "reports:export",
    "journal:read",
    "backtest:read",
  ],
  [Role.VIEWER]: [
    "accounts:read",
    "orders:read",
    "positions:read",
    "strategies:read",
    "risk:read",
    "analytics:read",
    "reports:read",
    "journal:read",
  ],
};

export function permissionsForRole(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function hasPermission(
  role: Role,
  permission: Permission,
  customPermissions?: Permission[],
): boolean {
  if (customPermissions?.includes(permission)) return true;
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function canActivateLiveTrading(role: Role): boolean {
  return role === Role.OWNER;
}
