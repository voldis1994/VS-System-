"use client";

import { cn } from "@/lib/utils";

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "profit" | "loss" | "accent" | "warn";
  className?: string;
}) {
  const tones = {
    neutral: "bg-white/5 text-white/70 border-white/10",
    profit: "bg-profit/15 text-profit border-profit/25",
    loss: "bg-loss/15 text-loss border-loss/25",
    accent: "bg-accent-muted text-accent-soft border-accent/30",
    warn: "bg-amber-500/15 text-amber-300 border-amber-400/30",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "inline-flex items-center gap-2 disabled:opacity-50",
        disabled ? "cursor-not-allowed" : "cursor-pointer",
      )}
    >
      <span
        className={cn(
          "relative h-5 w-9 rounded-full border transition-colors",
          checked ? "border-accent/50 bg-accent" : "border-white/15 bg-white/10",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-transform",
            checked ? "left-4" : "left-0.5",
          )}
        />
      </span>
      {label ? <span className="text-xs text-white/70">{label}</span> : null}
    </button>
  );
}

export function LiveDot({ label = "LIVE" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-profit">
      <span className="h-1.5 w-1.5 rounded-full bg-profit animate-pulse-live" />
      {label}
    </span>
  );
}
