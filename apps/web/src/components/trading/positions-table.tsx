"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { useAccounts, useInvalidateTrading, usePositions } from "@/lib/hooks";
import { formatPnl, pnlClass, uuid } from "@/lib/utils";
import { useState } from "react";
import { toast } from "sonner";

export function PositionsTable() {
  const token = useAuthStore((s) => s.accessToken);
  const { data: positions, isLoading } = usePositions();
  const { data: accounts } = useAccounts();
  const invalidate = useInvalidateTrading();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");
  const [partialVol, setPartialVol] = useState("");

  const accountName = (id: string) => accounts?.find((a) => a.id === id)?.name ?? id.slice(0, 8);

  async function run(id: string, fn: () => Promise<unknown>, ok: string) {
    setBusyId(id);
    try {
      await fn();
      toast.success(ok);
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  const open = (positions ?? []).filter((p) => p.status === "OPEN" || p.status === "PARTIALLY_CLOSED");

  return (
    <Panel title="Open Positions" delay={0.1}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-white/35">
            <tr className="border-b border-white/[0.06]">
              <th className="pb-2 pr-2 font-medium">Symbol</th>
              <th className="pb-2 pr-2 font-medium">Side</th>
              <th className="pb-2 pr-2 font-medium">Vol</th>
              <th className="pb-2 pr-2 font-medium">Open</th>
              <th className="pb-2 pr-2 font-medium">SL / TP</th>
              <th className="pb-2 pr-2 font-medium">PnL</th>
              <th className="pb-2 pr-2 font-medium">Account</th>
              <th className="pb-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {open.map((p) => (
              <tr key={p.id} className="border-b border-white/[0.04] align-top">
                <td className="py-2 pr-2 font-mono font-semibold text-white">{p.symbol}</td>
                <td className="py-2 pr-2">
                  <Badge tone={p.direction === "BUY" ? "profit" : "loss"}>{p.direction}</Badge>
                </td>
                <td className="py-2 pr-2 font-mono tabular-nums">{p.volume}</td>
                <td className="py-2 pr-2 font-mono tabular-nums text-white/70">{p.openPrice}</td>
                <td className="py-2 pr-2 font-mono tabular-nums text-white/55">
                  {p.stopLoss ?? "—"} / {p.takeProfit ?? "—"}
                </td>
                <td className={`py-2 pr-2 font-mono tabular-nums ${pnlClass(p.unrealizedPnl)}`}>
                  {formatPnl(p.unrealizedPnl)}
                </td>
                <td className="py-2 pr-2 text-white/50">{accountName(p.accountId)}</td>
                <td className="py-2">
                  <div className="flex flex-wrap gap-1">
                    <Button
                      size="sm"
                      variant="danger"
                      loading={busyId === p.id}
                      onClick={() =>
                        void run(
                          p.id,
                          () =>
                            api(`/positions/${p.id}/close`, {
                              method: "POST",
                              token: token!,
                              body: JSON.stringify({ clientRequestId: uuid() }),
                            }),
                          "Position closed",
                        )
                      }
                    >
                      Close
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyId === p.id}
                      onClick={() => {
                        setEditId(editId === p.id ? null : p.id);
                        setSl(p.stopLoss ?? "");
                        setTp(p.takeProfit ?? "");
                        setPartialVol("");
                      }}
                    >
                      Modify
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      loading={busyId === p.id}
                      onClick={() =>
                        void run(
                          p.id,
                          () =>
                            api(`/positions/${p.id}/break-even`, {
                              method: "POST",
                              token: token!,
                            }),
                          "Break-even activated",
                        )
                      }
                    >
                      BE
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busyId === p.id}
                      onClick={() =>
                        void run(
                          p.id,
                          () =>
                            api(`/positions/${p.id}/trailing`, {
                              method: "POST",
                              token: token!,
                              body: JSON.stringify({
                                enabled: !p.trailingEnabled,
                                distance: p.trailingDistance ?? "0.0010",
                              }),
                            }),
                          p.trailingEnabled ? "Trailing off" : "Trailing on",
                        )
                      }
                    >
                      Trail
                    </Button>
                  </div>
                  {editId === p.id ? (
                    <div className="mt-2 flex flex-wrap items-end gap-2 rounded border border-white/10 bg-navy-950/60 p-2">
                      <div>
                        <div className="mb-1 text-[10px] text-white/40">SL</div>
                        <Input className="h-8 w-24 font-mono" value={sl} onChange={(e) => setSl(e.target.value)} />
                      </div>
                      <div>
                        <div className="mb-1 text-[10px] text-white/40">TP</div>
                        <Input className="h-8 w-24 font-mono" value={tp} onChange={(e) => setTp(e.target.value)} />
                      </div>
                      <Button
                        size="sm"
                        variant="primary"
                        loading={busyId === p.id}
                        onClick={() =>
                          void run(
                            p.id,
                            () =>
                              api(`/positions/${p.id}/sl-tp`, {
                                method: "PATCH",
                                token: token!,
                                body: JSON.stringify({
                                  stopLoss: sl || null,
                                  takeProfit: tp || null,
                                }),
                              }),
                            "SL/TP updated",
                          )
                        }
                      >
                        Save SL/TP
                      </Button>
                      <div>
                        <div className="mb-1 text-[10px] text-white/40">Partial vol</div>
                        <Input
                          className="h-8 w-24 font-mono"
                          value={partialVol}
                          onChange={(e) => setPartialVol(e.target.value)}
                        />
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busyId === p.id}
                        disabled={!partialVol}
                        onClick={() =>
                          void run(
                            p.id,
                            () =>
                              api(`/positions/${p.id}/partial-close`, {
                                method: "POST",
                                token: token!,
                                body: JSON.stringify({
                                  volume: partialVol,
                                  clientRequestId: uuid(),
                                }),
                              }),
                            "Partial close submitted",
                          )
                        }
                      >
                        Partial
                      </Button>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {isLoading ? (
          <div className="py-8 text-center text-sm text-white/35">Loading positions…</div>
        ) : open.length === 0 ? (
          <div className="py-8 text-center text-sm text-white/35">No open positions</div>
        ) : null}
      </div>
    </Panel>
  );
}
