"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export function TradingPinModal({
  open,
  onClose,
  onVerified,
}: {
  open: boolean;
  onClose: () => void;
  onVerified?: () => void;
}) {
  const token = useAuthStore((s) => s.accessToken);
  const setTradingPinVerified = useAuthStore((s) => s.setTradingPinVerified);
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);

  if (!open) return null;

  async function verify() {
    if (!/^\d{6}$/.test(pin)) {
      toast.error("Trading PIN must be 6 digits");
      return;
    }
    setLoading(true);
    try {
      const res = await api<{ accessToken: string; tradingPinVerified: boolean }>(
        "/auth/trading-pin/verify",
        {
          method: "POST",
          token: token!,
          body: JSON.stringify({ pin }),
        },
      );
      setTradingPinVerified(true, res.accessToken);
      toast.success("Trading PIN verified");
      setPin("");
      onVerified?.();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "PIN verification failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-lg border border-white/10 bg-navy-900 p-5 shadow-glow">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h3 className="text-base font-semibold text-white">Verify Trading PIN</h3>
            <p className="mt-1 text-xs text-white/50">
              Required before enabling Live Trading. Paper mode remains the default.
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-white/40 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        <Input
          type="password"
          inputMode="numeric"
          maxLength={6}
          placeholder="••••••"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
          className="font-mono tracking-[0.4em]"
        />
        <div className="mt-4 flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant="primary" className="flex-1" loading={loading} onClick={() => void verify()}>
            Verify
          </Button>
        </div>
      </div>
    </div>
  );
}
