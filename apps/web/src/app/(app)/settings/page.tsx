"use client";

import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { TradingPinModal } from "@/components/ui/trading-pin-modal";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { useState } from "react";
import { toast } from "sonner";

export default function SettingsPage() {
  const user = useAuthStore((s) => s.user);
  const organization = useAuthStore((s) => s.organization);
  const token = useAuthStore((s) => s.accessToken);
  const tradingPinVerified = useAuthStore((s) => s.tradingPinVerified);
  const [pinOpen, setPinOpen] = useState(false);
  const [enabling2fa, setEnabling2fa] = useState(false);
  const [twoFaSecret, setTwoFaSecret] = useState<string | null>(null);

  async function enable2fa() {
    setEnabling2fa(true);
    try {
      const res = await api<{ secret?: string; otpauthUrl?: string }>("/auth/2fa/enable", {
        method: "POST",
        token: token!,
      });
      setTwoFaSecret(res.secret ?? res.otpauthUrl ?? "enabled");
      toast.success("2FA enrollment started");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "2FA enable failed");
    } finally {
      setEnabling2fa(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Panel title="Profile">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input
              readOnly
              value={`${user?.firstName ?? ""} ${user?.lastName ?? ""}`.trim()}
            />
          </Field>
          <Field label="Email">
            <Input readOnly value={user?.email ?? ""} />
          </Field>
          <Field label="Organization">
            <Input readOnly value={organization?.name ?? ""} />
          </Field>
          <Field label="Slug">
            <Input readOnly value={organization?.slug ?? ""} />
          </Field>
        </div>
      </Panel>

      <Panel title="Security">
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-white">Trading PIN</div>
              <div className="text-xs text-white/45">
                {tradingPinVerified ? "Verified this session" : "Not verified — required for live mode request"}
              </div>
            </div>
            <Button variant="primary" onClick={() => setPinOpen(true)}>
              Verify PIN
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-white">Two-factor auth</div>
              <div className="text-xs text-white/45">
                {user?.twoFactorEnabled ? "Enabled" : "Optional second factor for login"}
              </div>
            </div>
            <Button loading={enabling2fa} onClick={() => void enable2fa()}>
              Enable 2FA
            </Button>
          </div>
          {twoFaSecret ? (
            <div className="rounded border border-white/10 bg-navy-950/60 p-3 font-mono text-xs text-accent-soft break-all">
              {twoFaSecret}
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel title="Trading Mode Policy">
        <p className="text-sm text-white/55">
          NEXUS PRO defaults to <span className="text-white">Paper Trading</span>. Live mode can be
          requested only after PIN verification and remains blocked with an explicit warning until
          broker live credentials and org policy allow it.
        </p>
      </Panel>

      <TradingPinModal open={pinOpen} onClose={() => setPinOpen(false)} />
    </div>
  );
}
