"use client";

import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Panel, Stat } from "@/components/ui/panel";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { useRiskProfiles } from "@/lib/hooks";
import type { RiskProfile } from "@/lib/types";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

type Limits = {
  maxDailyRiskPercent: number;
  maxTotalRiskPercent: number;
  riskPerTradePercent: number;
  maxDrawdownPercent: number;
  maxOpenTrades: number;
};

const DEFAULTS: Limits = {
  maxDailyRiskPercent: 5,
  maxTotalRiskPercent: 15,
  riskPerTradePercent: 1.5,
  maxDrawdownPercent: 20,
  maxOpenTrades: 50,
};

export default function RiskPage() {
  const token = useAuthStore((s) => s.accessToken);
  const { data: profiles, isLoading } = useRiskProfiles();
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("Default Risk");
  const [limits, setLimits] = useState<Limits>(DEFAULTS);
  const [saving, setSaving] = useState(false);

  const selected = (profiles ?? []).find((p) => p.id === selectedId) ?? profiles?.[0];

  useEffect(() => {
    if (!selected) return;
    setSelectedId(selected.id);
    setName(selected.name);
    setLimits({
      maxDailyRiskPercent: selected.limitsJson.maxDailyRiskPercent ?? DEFAULTS.maxDailyRiskPercent,
      maxTotalRiskPercent: selected.limitsJson.maxTotalRiskPercent ?? DEFAULTS.maxTotalRiskPercent,
      riskPerTradePercent: selected.limitsJson.riskPerTradePercent ?? DEFAULTS.riskPerTradePercent,
      maxDrawdownPercent: selected.limitsJson.maxDrawdownPercent ?? DEFAULTS.maxDrawdownPercent,
      maxOpenTrades: selected.limitsJson.maxOpenTrades ?? DEFAULTS.maxOpenTrades,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate when selection id changes
  }, [selected?.id]);

  function setLimit<K extends keyof Limits>(key: K, value: number) {
    setLimits((prev) => ({ ...prev, [key]: value }));
  }

  async function save(createNew = false) {
    setSaving(true);
    try {
      if (!createNew && selected) {
        await api(`/risk/profiles/${selected.id}`, {
          method: "PATCH",
          token: token!,
          body: JSON.stringify({ name, limitsJson: limits }),
        });
        toast.success("Risk profile updated");
      } else {
        await api("/risk/profiles", {
          method: "POST",
          token: token!,
          body: JSON.stringify({
            name,
            scope: "ORGANIZATION",
            limitsJson: limits,
            priority: 50,
          }),
        });
        toast.success("Risk profile created");
      }
      void qc.invalidateQueries({ queryKey: ["risk-profiles"] });
    } catch (e) {
      // Fall back to create if PATCH not available
      if (!createNew) {
        try {
          await api("/risk/profiles", {
            method: "POST",
            token: token!,
            body: JSON.stringify({
              name: `${name} (updated)`,
              scope: "ORGANIZATION",
              limitsJson: limits,
              priority: 40,
            }),
          });
          toast.success("Risk profile created (API has no PATCH — saved as new)");
          void qc.invalidateQueries({ queryKey: ["risk-profiles"] });
        } catch (e2) {
          toast.error(e2 instanceof Error ? e2.message : "Save failed");
        }
      } else {
        toast.error(e instanceof Error ? e.message : "Save failed");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Panel title="Profiles">
        {isLoading ? (
          <div className="py-6 text-center text-sm text-white/35">Loading…</div>
        ) : (
          <div className="space-y-2">
            {(profiles ?? []).map((p: RiskProfile) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelectedId(p.id)}
                className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                  selected?.id === p.id
                    ? "border-accent/40 bg-accent-muted"
                    : "border-white/[0.06] hover:bg-white/[0.03]"
                }`}
              >
                <div className="text-sm font-medium text-white">{p.name}</div>
                <div className="text-[11px] text-white/40">
                  {p.scope} · priority {p.priority}
                </div>
              </button>
            ))}
            {(profiles ?? []).length === 0 ? (
              <div className="py-6 text-center text-sm text-white/35">No profiles</div>
            ) : null}
          </div>
        )}
      </Panel>

      <Panel title="Risk Limits" className="lg:col-span-2">
        <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-3">
          <Stat label="Per trade" value={`${limits.riskPerTradePercent}%`} tone="accent" />
          <Stat label="Daily max" value={`${limits.maxDailyRiskPercent}%`} />
          <Stat label="Drawdown" value={`${limits.maxDrawdownPercent}%`} tone="loss" />
        </div>

        <div className="space-y-4">
          <Field label="Profile name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          {(
            [
              ["riskPerTradePercent", "Risk per trade %", 0.1, 10, 0.1],
              ["maxDailyRiskPercent", "Max daily risk %", 1, 30, 0.5],
              ["maxTotalRiskPercent", "Max total risk %", 1, 50, 0.5],
              ["maxDrawdownPercent", "Max drawdown %", 5, 50, 1],
              ["maxOpenTrades", "Max open trades", 1, 100, 1],
            ] as const
          ).map(([key, label, min, max, step]) => (
            <div key={key}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-white/50">{label}</span>
                <span className="font-mono text-white">{limits[key]}</span>
              </div>
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={limits[key]}
                onChange={(e) => setLimit(key, Number(e.target.value))}
                className="w-full"
              />
            </div>
          ))}

          <div className="flex flex-wrap gap-2 pt-2">
            <Button variant="primary" loading={saving} onClick={() => void save(false)}>
              Save profile
            </Button>
            <Button variant="secondary" loading={saving} onClick={() => void save(true)}>
              Create new
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
