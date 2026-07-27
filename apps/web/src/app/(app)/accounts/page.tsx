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
  const [demo, setDemo] = useState(false);
  const [riskAccepted, setRiskAccepted] = useState(false);
  const tradingPinVerified = useAuthStore((s) => s.tradingPinVerified);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [fixCredsId, setFixCredsId] = useState<string | null>(null);
  const [fixApiKey, setFixApiKey] = useState("");
  const [fixIdentifier, setFixIdentifier] = useState("");
  const [fixPassword, setFixPassword] = useState("");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [bindId, setBindId] = useState<string | null>(null);
  const [capitalSubs, setCapitalSubs] = useState<
    Array<{
      accountId: string;
      accountName: string;
      preferred?: boolean;
      currency?: string;
      balance?: number;
      profitLoss?: number;
    }>
  >([]);
  const [bindValue, setBindValue] = useState("");
  const [portalCreds, setPortalCreds] = useState<{
    accountId: string;
    name: string;
    code: string;
    pin: string;
  } | null>(null);

  async function issueClientPortal(accountId: string) {
    setBusyId(accountId);
    try {
      const res = await api<{
        accountId: string;
        name: string;
        code: string;
        pin: string;
        note?: string;
      }>(`/accounts/${accountId}/client-portal`, {
        method: "POST",
        token: token ?? undefined,
      });
      setPortalCreds({
        accountId: res.accountId,
        name: res.name,
        code: res.code,
        pin: res.pin,
      });
      toast.success("Klienta PIN izveidots — saglabā tagad");
      await qc.invalidateQueries({ queryKey: ["accounts"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Neizdevās");
    } finally {
      setBusyId(null);
    }
  }

  async function revokeClientPortal(accountId: string) {
    setBusyId(accountId);
    try {
      await api(`/accounts/${accountId}/client-portal`, {
        method: "DELETE",
        token: token ?? undefined,
      });
      toast.success("Klienta piekļuve atcelta");
      setPortalCreds((c) => (c?.accountId === accountId ? null : c));
      await qc.invalidateQueries({ queryKey: ["accounts"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Neizdevās");
    } finally {
      setBusyId(null);
    }
  }

  async function createAccount() {
    if (provider === "CAPITAL" && !demo && !riskAccepted) {
      toast.error("Apstiprini LIVE riska brīdinājumu");
      return;
    }
    if (provider === "CAPITAL" && !demo && !tradingPinVerified) {
      toast.error("Vispirms Verify PIN (augšējā josla)");
      return;
    }
    if (provider === "CAPITAL" && (!apiKey.trim() || !identifier.trim() || !password)) {
      toast.error("Aizpildi Email, API Key un API Password");
      return;
    }

    const payload =
      provider === "CAPITAL"
        ? {
            name: name || (demo ? "Capital.com Demo" : "Capital.com LIVE"),
            provider: Provider.CAPITAL,
            platform: "CAPITAL",
            accountType: demo ? AccountType.DEMO : AccountType.LIVE,
            leverage: Number(leverage),
            startingBalance: "0",
            credentials: {
              apiKey: apiKey.trim(),
              identifier: identifier.trim(),
              password: password.trim(),
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
      await api(`/accounts/${account.id}/connect`, { method: "POST", token: token! });
      if (provider === "CAPITAL" && !demo) {
        await api(`/accounts/${account.id}/enable-live`, {
          method: "POST",
          token: token!,
          body: JSON.stringify({ riskAccepted: true }),
        });
        toast.success("Capital.com LIVE connected — real orders enabled");
      } else {
        toast.success(
          provider === "CAPITAL"
            ? demo
              ? "Capital.com DEMO connected"
              : "Connected"
            : "Paper account created",
        );
      }
      setApiKey("");
      setPassword("");
      void qc.invalidateQueries({ queryKey: ["accounts"] });
      void qc.invalidateQueries({ queryKey: ["analytics-overview"] });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Create failed";
      toast.error(msg, { duration: 12000 });
    } finally {
      setCreating(false);
    }
  }

  async function openCapitalBind(id: string, current?: string | null) {
    setBusyId(id);
    setBindId(id);
    setFixCredsId(null);
    setRenameId(null);
    try {
      const res = await api<{
        externalAccountId?: string | null;
        accounts: Array<{
          accountId: string;
          accountName: string;
          preferred?: boolean;
          currency?: string;
          balance?: number;
          profitLoss?: number;
        }>;
      }>(`/accounts/${id}/capital-accounts`, { token: token! });
      setCapitalSubs(res.accounts ?? []);
      setBindValue(
        current ||
          res.externalAccountId ||
          res.accounts?.find((x) => x.preferred)?.accountId ||
          res.accounts?.[0]?.accountId ||
          "",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load Capital accounts");
      setBindId(null);
    } finally {
      setBusyId(null);
    }
  }

  async function saveCapitalBind(id: string) {
    if (!bindValue) {
      toast.error("Izvēlies Capital CFD kontu");
      return;
    }
    setBusyId(id);
    try {
      await api(`/accounts/${id}/bind-capital`, {
        method: "POST",
        token: token!,
        body: JSON.stringify({ externalAccountId: bindValue }),
      });
      toast.success("Capital CFD konts piesaistīts — Sync opens/PnL");
      setBindId(null);
      void qc.invalidateQueries({ queryKey: ["accounts"] });
      void qc.invalidateQueries({ queryKey: ["positions"] });
      void qc.invalidateQueries({ queryKey: ["analytics-overview"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bind failed");
    } finally {
      setBusyId(null);
    }
  }

  async function saveRename(id: string) {
    const next = renameValue.trim();
    if (!next) {
      toast.error("Nosaukums nevar būt tukšs");
      return;
    }
    setBusyId(id);
    try {
      await api(`/accounts/${id}`, {
        method: "PATCH",
        token: token!,
        body: JSON.stringify({ name: next.slice(0, 80) }),
      });
      toast.success("Nosaukums saglabāts");
      setRenameId(null);
      void qc.invalidateQueries({ queryKey: ["accounts"] });
      void qc.invalidateQueries({ queryKey: ["analytics-overview"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rename failed");
    } finally {
      setBusyId(null);
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
      toast.error(e instanceof Error ? e.message : `${label} failed`, {
        duration: 12000,
      });
    } finally {
      setBusyId(null);
    }
  }

  async function saveCredentials(id: string) {
    if (!fixApiKey.trim() || !fixIdentifier.trim() || !fixPassword) {
      toast.error("Aizpildi Email, API Key un API Password");
      return;
    }
    setBusyId(id);
    try {
      await api(`/accounts/${id}/credentials`, {
        method: "POST",
        token: token!,
        body: JSON.stringify({
          apiKey: fixApiKey.trim(),
          identifier: fixIdentifier.trim(),
          password: fixPassword.trim(),
        }),
      });
      toast.success("Credentials updated — connected");
      setFixCredsId(null);
      setFixApiKey("");
      setFixPassword("");
      void qc.invalidateQueries({ queryKey: ["accounts"] });
      void qc.invalidateQueries({ queryKey: ["analytics-overview"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Credentials update failed", {
        duration: 12000,
      });
    } finally {
      setBusyId(null);
    }
  }

  async function removeAccount(id: string) {
    setBusyId(id);
    try {
      await api(`/accounts/${id}`, { method: "DELETE", token: token! });
      toast.success("Account removed");
      void qc.invalidateQueries({ queryKey: ["accounts"] });
      void qc.invalidateQueries({ queryKey: ["analytics-overview"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusyId(null);
    }
  }

  async function removeAllErrors() {
    setCreating(true);
    try {
      const res = await api<{ archived: number }>("/accounts/archive-errors", {
        method: "POST",
        token: token!,
      });
      toast.success(`Removed ${res.archived} ERROR account(s)`);
      void qc.invalidateQueries({ queryKey: ["accounts"] });
      void qc.invalidateQueries({ queryKey: ["analytics-overview"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Cleanup failed");
    } finally {
      setCreating(false);
    }
  }

  const totalEquity = (accounts ?? []).reduce((s, a) => s + Number(a.equity || 0), 0);
  const errorCount = (accounts ?? []).filter((a) => a.connectionStatus === "ERROR").length;

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
                  setName(p === "CAPITAL" ? "Capital.com LIVE" : "Paper Account");
                  if (p === "CAPITAL") setDemo(false);
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
                  Capital.com → Settings → API integrations → Generate key.
                  <br />
                  <strong className="text-accent">API Password ≠ login parole</strong> — tā ir
                  atsevišķa parole, ko ievadi key ģenerēšanas brīdī.
                </p>
                <Field label="Mode">
                  <Select
                    value={demo ? "demo" : "live"}
                    onChange={(e) => {
                      const isDemo = e.target.value === "demo";
                      setDemo(isDemo);
                      setName(isDemo ? "Capital.com Demo" : "Capital.com LIVE");
                    }}
                  >
                    <option value="live">LIVE (real money)</option>
                    <option value="demo">DEMO</option>
                  </Select>
                </Field>
                {!demo ? (
                  <label className="flex items-start gap-2 rounded-md border border-loss/40 bg-loss/10 p-2 text-[11px] text-white/80">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={riskAccepted}
                      onChange={(e) => setRiskAccepted(e.target.checked)}
                    />
                    <span>
                      Saprotu: LIVE treidi iet uz reālo Capital.com naudu. CFD risks ir augsts.
                      {!tradingPinVerified ? " Vispirms Verify PIN augšā." : ""}
                    </span>
                  </label>
                ) : null}
                <Field label="Email / login (Capital.com)">
                  <Input
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="you@email.com"
                    autoComplete="username"
                  />
                </Field>
                <Field label="API Key">
                  <Input
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value.trim())}
                    className="font-mono"
                    placeholder="paste API key"
                    autoComplete="off"
                  />
                </Field>
                <Field label="API Password (custom, NOT login password)">
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="password created with the API key"
                    autoComplete="new-password"
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
              {provider === "CAPITAL"
                ? demo
                  ? "Connect Capital.com DEMO"
                  : "Connect Capital.com LIVE"
                : "Create paper account"}
            </Button>
          </div>
        </Panel>

        <Panel title="Trading Accounts" className="lg:col-span-2">
          {errorCount > 0 ? (
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="text-[11px] text-white/45">
                {errorCount} ERROR account(s) — vecie neveiksmīgie mēģinājumi
              </p>
              <Button
                size="sm"
                variant="danger"
                loading={creating}
                onClick={() => void removeAllErrors()}
              >
                Delete all ERROR
              </Button>
            </div>
          ) : null}
          {isLoading ? (
            <div className="py-8 text-center text-sm text-white/35">Loading…</div>
          ) : (
            <div className="space-y-3">
              {(accounts ?? []).map((a) => (
                <div
                  key={a.id}
                  className="rounded-md border border-white/[0.06] bg-white/[0.02] p-3"
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        {renameId === a.id ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Input
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              className="h-8 w-48 font-medium"
                              maxLength={80}
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void saveRename(a.id);
                                if (e.key === "Escape") setRenameId(null);
                              }}
                            />
                            <Button
                              size="sm"
                              loading={busyId === a.id}
                              onClick={() => void saveRename(a.id)}
                            >
                              Save
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setRenameId(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="font-medium text-white hover:text-accent"
                            title="Pārdēvēt kontu"
                            onClick={() => {
                              setRenameId(a.id);
                              setRenameValue(a.name);
                              setFixCredsId(null);
                            }}
                          >
                            {a.name}
                          </button>
                        )}
                        <Badge tone="accent">{a.provider}</Badge>
                        <Badge tone="neutral">{a.accountType}</Badge>
                        <Badge
                          tone={
                            a.connectionStatus === "CONNECTED"
                              ? "profit"
                              : a.connectionStatus === "ERROR"
                                ? "loss"
                                : "neutral"
                          }
                        >
                          {a.connectionStatus}
                        </Badge>
                        <Badge tone={a.liveTradingEnabled ? "loss" : "neutral"}>
                          {a.liveTradingEnabled ? "LIVE ON" : "LIVE OFF"}
                        </Badge>
                        {a.clientPortalEnabled ? (
                          <Badge tone="accent">
                            PIN {a.clientPortalCode ?? "ON"}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-3 font-mono text-xs text-white/50">
                        <span>Eq {formatMoney(a.equity, a.baseCurrency)}</span>
                        <span>Bal {formatMoney(a.balance, a.baseCurrency)}</span>
                        <span className={pnlClass(a.floatingPnl)}>
                          Fl {formatPnl(a.floatingPnl)}
                        </span>
                        <span>Lev 1:{a.leverage}</span>
                        {a.provider === "CAPITAL" && a.externalAccountId ? (
                          <span title="Capital CFD sub-account">
                            CFD {a.externalAccountId}
                          </span>
                        ) : null}
                      </div>
                      {bindId === a.id ? (
                        <div className="mt-2 flex flex-wrap items-end gap-2">
                          <Field label="Capital CFD konts (opens / PnL)">
                            <Select
                              value={bindValue}
                              onChange={(e) => setBindValue(e.target.value)}
                            >
                              <option value="">— choose —</option>
                              {capitalSubs.map((c) => (
                                <option key={c.accountId} value={c.accountId}>
                                  {c.accountName}
                                  {c.preferred ? " · preferred" : ""} ·{" "}
                                  {c.accountId}
                                  {c.profitLoss != null
                                    ? ` · Fl ${Number(c.profitLoss).toFixed(2)}`
                                    : ""}
                                </option>
                              ))}
                            </Select>
                          </Field>
                          <Button
                            size="sm"
                            loading={busyId === a.id}
                            onClick={() => void saveCapitalBind(a.id)}
                          >
                            Bind + Sync
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setBindId(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {renameId !== a.id ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setRenameId(a.id);
                            setRenameValue(a.name);
                            setFixCredsId(null);
                            setBindId(null);
                          }}
                        >
                          Rename
                        </Button>
                      ) : null}
                      {a.provider === "CAPITAL" && a.connectionStatus === "CONNECTED" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          loading={busyId === a.id && bindId === a.id}
                          onClick={() =>
                            void openCapitalBind(a.id, a.externalAccountId)
                          }
                        >
                          Capital CFD
                        </Button>
                      ) : null}
                      {a.connectionStatus !== "CONNECTED" ? (
                        <Button
                          size="sm"
                          loading={busyId === a.id}
                          onClick={() => void action(a.id, "connect", "Connected")}
                        >
                          Connect
                        </Button>
                      ) : null}
                      {a.provider === "CAPITAL" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setFixCredsId((cur) => (cur === a.id ? null : a.id))
                          }
                        >
                          Fix API key
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        loading={busyId === a.id}
                        onClick={() => void issueClientPortal(a.id)}
                      >
                        {a.clientPortalEnabled ? "Jauns klienta PIN" : "Klienta PIN"}
                      </Button>
                      {a.clientPortalEnabled ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busyId === a.id}
                          onClick={() => void revokeClientPortal(a.id)}
                        >
                          Atcelt PIN
                        </Button>
                      ) : null}
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
                          variant="ghost"
                          loading={busyId === a.id}
                          onClick={() => void action(a.id, "lock", "Locked")}
                        >
                          Lock
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="danger"
                        loading={busyId === a.id}
                        onClick={() => void removeAccount(a.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>

                  {fixCredsId === a.id ? (
                    <div className="mt-3 space-y-2 border-t border-white/[0.06] pt-3">
                      <p className="text-[11px] text-white/45">
                        Jauns API key + <strong className="text-accent">custom API password</strong>{" "}
                        (ne login parole). Mode: {a.accountType}.
                      </p>
                      <div className="grid gap-2 md:grid-cols-3">
                        <Field label="Email">
                          <Input
                            value={fixIdentifier}
                            onChange={(e) => setFixIdentifier(e.target.value)}
                            placeholder="you@email.com"
                            autoComplete="username"
                          />
                        </Field>
                        <Field label="API Key">
                          <Input
                            value={fixApiKey}
                            onChange={(e) => setFixApiKey(e.target.value.trim())}
                            className="font-mono"
                            autoComplete="off"
                          />
                        </Field>
                        <Field label="API Password">
                          <Input
                            type="password"
                            value={fixPassword}
                            onChange={(e) => setFixPassword(e.target.value)}
                            autoComplete="new-password"
                          />
                        </Field>
                      </div>
                      <Button
                        size="sm"
                        variant="primary"
                        loading={busyId === a.id}
                        onClick={() => void saveCredentials(a.id)}
                      >
                        Save & reconnect
                      </Button>
                    </div>
                  ) : null}
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

      {portalCreds ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-xl border border-accent/40 bg-bg p-5 shadow-2xl">
            <h3 className="text-lg font-semibold text-white">Klienta piekļuve</h3>
                <p className="mt-1 text-sm text-white/55">
              {portalCreds.name} — saglabā PIN tagad. Klients instalē app no{" "}
              <span className="text-accent">/client</span> (Add to Home Screen) vai ielogojas turpat.
            </p>
            <div className="mt-4 space-y-2 rounded-md border border-white/10 bg-white/[0.03] p-3 font-mono text-sm">
              <div>
                Kods: <strong className="text-accent">{portalCreds.code}</strong>
              </div>
              <div>
                PIN: <strong className="text-accent">{portalCreds.pin}</strong>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(
                    `VS Client app\n1) Atver: ${window.location.origin}/client\n2) iPhone: Share → Add to Home Screen\n3) Kods: ${portalCreds.code}\n4) PIN: ${portalCreds.pin}`,
                  );
                  toast.success("Nokopēts");
                }}
              >
                Kopēt
              </Button>
              <Button onClick={() => setPortalCreds(null)}>Aizvērt</Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
