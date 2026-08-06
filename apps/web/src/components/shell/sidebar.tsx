"use client";

import { cn } from "@/lib/utils";
import {
  Activity,
  Bell,
  BookOpen,
  Bot,
  Copy,
  FileBarChart2,
  FlaskConical,
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
  { href: "/lab", label: "Strategy Lab", icon: FlaskConical, badge: "TEST" },
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
    <aside className="relative flex h-full w-56 shrink-0 flex-col border-r border-accent/20 bg-[color:var(--bg-deep)]/95">
      <div className="pointer-events-none absolute inset-y-0 right-0 w-px bg-gradient-to-b from-transparent via-accent/40 to-transparent" />
      <div className="border-b border-accent/20 px-4 py-4">
        <div className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/vs-system-logo.png"
            alt="VS System"
            className="h-10 w-10 object-cover ring-1 ring-accent/50 drop-shadow-[0_0_14px_rgba(0,240,255,0.4)]"
          />
          <div>
            <div className="font-display text-base font-bold tracking-[0.08em] text-white">
              VS <span className="text-accent drop-shadow-[0_0_10px_rgba(0,240,255,0.45)]">SYSTEM</span>
            </div>
            <div className="mt-0.5 text-[10px] uppercase tracking-[0.28em] text-accent/60">
              Cyber Deck
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
                  ? "border border-accent/35 bg-accent/15 text-white shadow-[0_0_16px_rgba(0,240,255,0.15)]"
                  : href === "/strategies"
                    ? "border border-accent/30 bg-accent/5 text-white hover:bg-accent/10"
                    : "border border-transparent text-white/55 hover:border-accent/15 hover:bg-white/[0.04] hover:text-white",
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
      <div className="border-t border-accent/15 p-3 text-[10px] tracking-wide text-accent/40">
        VS System · neon command
      </div>
    </aside>
  );
}
