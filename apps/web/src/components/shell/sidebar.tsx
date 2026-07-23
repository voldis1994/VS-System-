"use client";

import { cn } from "@/lib/utils";
import {
  Activity,
  Bell,
  BookOpen,
  Bot,
  Copy,
  FileBarChart2,
  LayoutDashboard,
  LineChart,
  ScrollText,
  Settings,
  ShieldAlert,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/accounts", label: "Accounts", icon: Wallet },
  { href: "/strategies", label: "Strategies", icon: Bot, badge: "AUTO" },
  { href: "/copier", label: "Trade Copier", icon: Copy },
  { href: "/terminal", label: "Market Analysis", icon: LineChart },
  { href: "/automation", label: "Automation", icon: Activity },
  { href: "/risk", label: "Risk Manager", icon: ShieldAlert },
  { href: "/reports", label: "Reports", icon: FileBarChart2 },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/journal", label: "Journal", icon: BookOpen },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/audit", label: "Audit", icon: ScrollText },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-white/[0.06] bg-navy-950/90">
      <div className="border-b border-white/[0.06] px-4 py-4">
        <div className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/vs-system-logo.png"
            alt="VS System"
            className="h-9 w-9 rounded-md object-cover ring-1 ring-white/10"
          />
          <div>
            <div className="font-sans text-lg font-bold tracking-tight text-white">
              VS <span className="text-accent">System</span>
            </div>
            <div className="mt-0.5 text-[10px] uppercase tracking-[0.2em] text-white/35">
              Trading Platform
            </div>
          </div>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {NAV.map((item) => {
          const { href, label, icon: Icon } = item;
          const badge = "badge" in item ? item.badge : undefined;
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-accent-muted text-white"
                  : href === "/strategies"
                    ? "border border-accent/30 bg-accent/5 text-white hover:bg-accent/10"
                    : "text-white/55 hover:bg-white/[0.04] hover:text-white",
              )}
            >
              <Icon className={cn("h-4 w-4", active || href === "/strategies" ? "text-accent-soft" : "text-white/40")} />
              <span className="flex-1">{label}</span>
              {badge ? (
                <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent">
                  {badge}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-white/[0.06] p-3 text-[10px] text-white/30">
        VS System · command deck
      </div>
    </aside>
  );
}
