"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Panel, Stat } from "@/components/ui/panel";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { useAccounts } from "@/lib/hooks";
import { formatMoney, formatPnl, pnlClass } from "@/lib/utils";
import { AccountType, CreateAccountSchema, Provider } from "@nexus/domain";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

export default function AccountsPage() {
  const token = useAuthStore((s) => s.accessToken);
  const { data: accounts, isLoading } = useAccounts();
  const qc = useQueryClient();
  const [provider, setProvider] = useState<"PAPER" | "CAPITAL">("PAPER");
  const [name, setName] = useState("Paper Account");
  const [startingBalance, setStartingBalance] = useState("100000");
  const [leverage, setLeverage] = useState("100");
  const [apiKey, setApiKey] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [demo, setDemo] = useState(true);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function createAccount() {
    const payload =
      provider === "CAPITAL"
        ? {
            name: name || "Capital.com",
            provider: Provider.CAPITAL,
            platform: "CAPITAL",
            accountType: demo ? AccountType.DEMO : AccountType.LIVE,
            leverage: Number(leverage),
            startingBalance: "0",
            credentials: {
              apiKey,
              identifier,
              password,
              demo,
            },
          }
        : {
            name,
            provider: Provider.PAPER,
            platform: "PAPER",
            accountType: AccountType.PAPER,
            startingBalance,
            leverage: Number(leverage),
          };

    const parsed = CreateAccountSchema.safeParse(payload);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid account data");
      return;
    }
    setCreating(true);
    try {
      const account = await api<{ id: string }>("/accounts", {
        method: "POST",
        token: token!,
        body: JSON.stringify(parsed.data),
      });
      toast.success(provider === "CAPITAL" ? "Capital.com account created" : "Paper account created");
      void qc.invalidateQueries({ queryKey: ["accounts"] });
      if (provider === "CAPITAL") {
        await api(`/accounts/${account.id}/connect`, { method: "POST", token: token! });
        toast.success(demo ? "Capital.com DEMO connected" : "Capital.com LIVE connected");
        void qc.invalidateQueries({ queryKey: ["accounts"] });
        void qc.invalidateQueries({ queryKey: ["analytics-overview"] });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }

  async function action(id: string, path: string, label: string) {
    setBusyId(id);
    try {
      await api(`/accounts/${id}/${path}`, { method: "POST", token: token! });
      toast.success(label);
      void qc.invalidateQueries({ queryKey: ["accounts"] });
      void qc.invalidateQueries({ queryKey: ["analytics-overview"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `${label} failed`);
    } finally {
      setBusyId(null);
    }
  }

  const totalEquity = (accounts ?? []).reduce((s, a) => s + Number(a.equity || 0), 0);

  return (
    <div className="space-y-4">
      <Panel title="Account Overview">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="Accounts" value={String(accounts?.length ?? 0)} />
          <Stat label="Total equity" value={formatMoney(totalEquity)} tone="accent" />
          <Stat
            label="Connected"
            value={String((accounts ?? []).filter((a) => a.connectionStatus === "CONNECTED").length)}
            tone="profit"
          />
          <Stat
            label="Locked"
            value={String((accounts ?? []).filter((a) => a.status === "LOCKED").length)}
          />
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Add Account" className="lg:col-span-1">
          <div className="space-y-3">
            <Field label="Provider">
              <Select
                value={provider}
                onChange={(e) => {
                  const p = e.target.value as "PAPER" | "CAPITAL";
                  setProvider(p);
                  setName(p === "CAPITAL" ? "Capital.com Demo" : "Paper Account");
                }}
              >
                <option value="PAPER">Paper (simulator)</option>
                <option value="CAPITAL">Capital.com</option>
              </Select>
            </Field>
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>

            {provider === "PAPER" ? (
              <>
                <Field label="Starting balance">
                  <Input
                    value={startingBalance}
                    onChange={(e) => setStartingBalance(e.target.value)}
                    className="font-mono"
                  />
                </Field>
                <Field label="Leverage">
                  <Select value={leverage} onChange={(e) => setLeverage(e.target.value)}>
                    {["50", "100", "200", "500"].map((v) => (
                      <option key={v} value={v}>
                        1:{v}
                      </option>
                    ))}
                  </Select>
                </Field>
              </>
            ) : (
              <>
                <p className="text-[11px] leading-relaxed text-white/45">
                  Capital.com → Settings → API integrations → Generate key. Sāc ar{" "}
                  <strong className="text-white/70">Demo</strong>.
                </p>
                <Field label="Mode">
                  <Select
                    value={demo ? "demo" : "live"}
                    onChange={(e) => setDemo(e.target.value === "demo")}
                  >
                    <option value="demo">DEMO (recommended)</option>
                    <option value="live">LIVE (real money)</option>
                  </Select>
                </Field>
                <Field label="Email / login">
                  <Input
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="you@email.com"
                  />
                </Field>
                <Field label="API Key">
                  <Input
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="font-mono"
                  />
                </Field>
                <Field label="API Password">
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
              </>
            )}

            <Button
              variant="primary"
              className="w-full"
              loading={creating}
              onClick={() => void createAccount()}
            >
              {provider === "CAPITAL" ? "Connect Capital.com" : "Create paper account"}
            </Button>
          </div>
        </Panel>

        <Panel title="Trading Accounts" className="lg:col-span-2">
          {isLoading ? (
            <div className="py-8 text-center text-sm text-white/35">Loading…</div>
          ) : (
            <div className="space-y-3">
              {(accounts ?? []).map((a) => (
                <div
                  key={a.id}
                  className="flex flex-col gap-3 rounded-md border border-white/[0.06] bg-white/[0.02] p-3 md:flex-row md:items-center md:justify-between"
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-white">{a.name}</span>
                      <Badge tone="accent">{a.provider}</Badge>
                      <Badge tone="neutral">{a.accountType}</Badge>
                      <Badge tone={a.connectionStatus === "CONNECTED" ? "profit" : "neutral"}>
                        {a.connectionStatus}
                      </Badge>
                      <Badge tone={a.status === "LOCKED" ? "warn" : "neutral"}>{a.status}</Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-3 font-mono text-xs text-white/50">
                      <span>Eq {formatMoney(a.equity, a.baseCurrency)}</span>
                      <span>Bal {formatMoney(a.balance, a.baseCurrency)}</span>
                      <span className={pnlClass(a.floatingPnl)}>Fl {formatPnl(a.floatingPnl)}</span>
                      <span>Lev 1:{a.leverage}</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      loading={busyId === a.id}
                      onClick={() => void action(a.id, "connect", "Connected")}
                    >
                      Connect
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busyId === a.id}
                      onClick={() => void action(a.id, "sync", "Synced")}
                    >
                      Sync
                    </Button>
                    {a.status === "LOCKED" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        loading={busyId === a.id}
                        onClick={() => void action(a.id, "unlock", "Unlocked")}
                      >
                        Unlock
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="danger"
                        loading={busyId === a.id}
                        onClick={() => void action(a.id, "lock", "Locked")}
                      >
                        Lock
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              {(accounts ?? []).length === 0 ? (
                <div className="py-8 text-center text-sm text-white/35">
                  Add Paper or Capital.com account
                </div>
              ) : null}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
