"use client";

import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import type { ReactNode } from "react";

export function Panel({
  children,
  className,
  title,
  action,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  action?: ReactNode;
  delay?: number;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay }}
      className={cn(
        "rounded-lg border border-accent/20 bg-navy-900/80 shadow-[0_0_24px_rgba(0,240,255,0.06)] backdrop-blur-sm",
        className,
      )}
    >
      {(title || action) && (
        <div className="flex items-center justify-between border-b border-accent/15 px-4 py-2.5">
          {title ? (
            <h2 className="font-display text-xs font-semibold uppercase tracking-[0.18em] text-accent-soft/90">
              {title}
            </h2>
          ) : (
            <span />
          )}
          {action}
        </div>
      )}
      <div className="p-4">{children}</div>
    </motion.section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "profit" | "loss" | "neutral" | "accent";
}) {
  const toneClass =
    tone === "profit"
      ? "text-profit"
      : tone === "loss"
        ? "text-loss"
        : tone === "accent"
          ? "text-accent-soft"
          : "text-white";

  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[0.16em] text-white/40">{label}</div>
      <div className={cn("mt-1 font-mono text-lg font-semibold tabular-nums", toneClass)}>{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-white/35">{hint}</div> : null}
    </div>
  );
}
