"use client";

import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { useAccounts, useInvalidateTrading, useTicks } from "@/lib/hooks";
import { uuid } from "@/lib/utils";
import { OrderDirection, OrderType, VolumeMode } from "@nexus/domain";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type CapitalMarket = {
  epic: string;
  name: string;
  instrumentType?: string;
  bid?: number;
  offer?: number;
  marketStatus?: string;
};

export function OrderTicket() {
  const token = useAuthStore((s) => s.accessToken);
  const { data: accounts } = useAccounts();
  const { data: ticks } = useTicks();
  const invalidate = useInvalidateTrading();

  const [accountId, setAccountId] = useState("");
  const [symbol, setSymbol] = useState("EURUSD");
  const [marketQuery, setMarketQuery] = useState("");
  const [markets, setMarkets] = useState<CapitalMarket[]>([]);
  const [loadingMarkets, setLoadingMarkets] = useState(false);
  const [direction, setDirection] = useState<"BUY" | "SELL">("BUY");
  const [type, setType] = useState<"MARKET" | "LIMIT" | "STOP">("MARKET");
  const [volumeMode, setVolumeMode] = useState<"FIXED_LOT" | "RISK_PERCENT">("FIXED_LOT");
  const [volume, setVolume] = useState("0.10");
  const [riskPercent, setRiskPercent] = useState("1.0");
  const [entryPrice, setEntryPrice] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [loading, setLoading] = useState(false);

  const selectedAccount = (accounts ?? []).find((a) => a.id === accountId) ?? accounts?.[0];
  const isCapital = selectedAccount?.provider === "CAPITAL";

  const symbolOptions = useMemo(() => {
    if (markets.length > 0) return markets;
    const fromTicks = (ticks ?? []).map((t) => ({
      epic: t.symbol,
      name: t.symbol,
    }));
    return fromTicks.length
      ? fromTicks
      : [
          { epic: "EURUSD", name: "EUR/USD" },
          { epic: "GOLD", name: "Gold" },
          { epic: "BITCOIN", name: "Bitcoin" },
          { epic: "US100", name: "US Tech 100" },
          { epic: "US30", name: "Wall Street 30" },
        ];
  }, [markets, ticks]);

  async function loadMarkets(q?: string) {
    if (!token) return;
    setLoadingMarkets(true);
    try {
      const res = await api<{ markets: CapitalMarket[] }>(
        `/capital/markets${q ? `?q=${encodeURIComponent(q)}` : ""}`,
        { token },
      );
      setMarkets(res.markets ?? []);
      if (!q && res.markets?.[0] && !symbol) {
        setSymbol(res.markets[0].epic);
      }
    } catch (e) {
      if (isCapital) {
        toast.error(e instanceof Error ? e.message : "Markets load failed");
      }
    } finally {
      setLoadingMarkets(false);
    }
  }

  async function syncMarkets() {
    if (!token) return;
    setLoadingMarkets(true);
    try {
      const res = await api<{ count: number }>("/capital/markets/sync", {
        method: "POST",
        token,
      });
      toast.success(`Synced ${res.count} Capital.com markets`);
      await loadMarkets();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setLoadingMarkets(false);
    }
  }

  useEffect(() => {
    if (isCapital) void loadMarkets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCapital, token]);

  async function submit() {
    const acc = selectedAccount;
    if (!acc) {
      toast.error("Select an account");
      return;
    }
    if (volumeMode === "FIXED_LOT" && !volume) {
      toast.error("Volume required");
      return;
    }
    if (volumeMode === "RISK_PERCENT" && (!riskPercent || !stopLoss)) {
      toast.error("Risk % and stop loss required");
      return;
    }

    setLoading(true);
    try {
      const body = {
        clientRequestId: uuid(),
        accountIds: [acc.id],
        symbol,
        type,
        direction,
        volumeMode,
        ...(volumeMode === "FIXED_LOT" ? { volume } : { riskPercent: Number(riskPercent) }),
        ...(type !== "MARKET" && entryPrice ? { entryPrice } : {}),
        ...(stopLoss ? { stopLoss } : {}),
        ...(takeProfit ? { takeProfit } : {}),
        confirmSoftWarnings: true,
      };
      await api("/orders", {
        method: "POST",
        token: token!,
        body: JSON.stringify(body),
      });
      toast.success(`${direction} ${symbol} submitted`);
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Order failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Panel title="Order Ticket" delay={0.05}>
      <div className="space-y-3">
        <Field label="Account">
          <Select
            value={selectedAccount?.id ?? ""}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {(accounts ?? []).length === 0 ? <option value="">No accounts</option> : null}
            {(accounts ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.accountType}
              </option>
            ))}
          </Select>
        </Field>

        {isCapital ? (
          <div className="flex gap-2">
            <Input
              value={marketQuery}
              onChange={(e) => setMarketQuery(e.target.value)}
              placeholder="Search Capital markets (GOLD, BITCOIN…)"
              className="font-mono text-xs"
            />
            <Button
              size="sm"
              loading={loadingMarkets}
              onClick={() => void loadMarkets(marketQuery.trim() || undefined)}
            >
              Find
            </Button>
            <Button size="sm" variant="outline" loading={loadingMarkets} onClick={() => void syncMarkets()}>
              Sync
            </Button>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Symbol (Capital epic)">
            <Select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {symbolOptions.map((s) => (
                <option key={s.epic} value={s.epic}>
                  {s.epic}
                  {s.name && s.name !== s.epic ? ` — ${s.name}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
              <option value={OrderType.MARKET}>Market</option>
              <option value={OrderType.LIMIT}>Limit</option>
              <option value={OrderType.STOP}>Stop</option>
            </Select>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant={direction === "BUY" ? "success" : "secondary"}
            onClick={() => setDirection(OrderDirection.BUY)}
          >
            BUY
          </Button>
          <Button
            type="button"
            variant={direction === "SELL" ? "danger" : "secondary"}
            onClick={() => setDirection(OrderDirection.SELL)}
          >
            SELL
          </Button>
        </div>

        <Field label="Volume mode">
          <Select
            value={volumeMode}
            onChange={(e) => setVolumeMode(e.target.value as typeof volumeMode)}
          >
            <option value={VolumeMode.FIXED_LOT}>Fixed lot</option>
            <option value={VolumeMode.RISK_PERCENT}>Risk %</option>
          </Select>
        </Field>

        {volumeMode === "FIXED_LOT" ? (
          <Field label="Volume">
            <Input value={volume} onChange={(e) => setVolume(e.target.value)} className="font-mono" />
          </Field>
        ) : (
          <Field label="Risk %">
            <Input
              value={riskPercent}
              onChange={(e) => setRiskPercent(e.target.value)}
              className="font-mono"
            />
          </Field>
        )}

        {type !== "MARKET" ? (
          <Field label="Entry price">
            <Input value={entryPrice} onChange={(e) => setEntryPrice(e.target.value)} className="font-mono" />
          </Field>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Stop loss">
            <Input value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} className="font-mono" />
          </Field>
          <Field label="Take profit">
            <Input value={takeProfit} onChange={(e) => setTakeProfit(e.target.value)} className="font-mono" />
          </Field>
        </div>

        <Button
          variant="primary"
          className="w-full"
          loading={loading}
          disabled={!selectedAccount}
          onClick={() => void submit()}
        >
          Submit {direction}
        </Button>
      </div>
    </Panel>
  );
}
