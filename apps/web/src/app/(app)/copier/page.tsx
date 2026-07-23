"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { useAccounts, useCopiers } from "@/lib/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";

export default function CopierPage() {
  const token = useAuthStore((s) => s.accessToken);
  const { data: copiers, isLoading } = useCopiers();
  const { data: accounts } = useAccounts();
  const qc = useQueryClient();
  const [name, setName] = useState("Primary Copier");
  const [masterId, setMasterId] = useState("");
  const [followerId, setFollowerId] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const masters = accounts ?? [];
  const followers = useMemo(
    () => (accounts ?? []).filter((a) => a.id !== (masterId || masters[0]?.id)),
    [accounts, masterId, masters],
  );

  async function create() {
    const master = masterId || masters[0]?.id;
    const follower = followerId || followers[0]?.id;
    if (!master || !follower) {
      toast.error("Need at least two accounts for copy trading");
      return;
    }
    setCreating(true);
    try {
      await api("/copiers", {
        method: "POST",
        token: token!,
        body: JSON.stringify({
          name,
          masterAccountId: master,
          followersJson: [{ accountId: follower, multiplier: 1 }],
          copyRulesJson: { copySlTp: true, reverse: false },
          executionRulesJson: { delayMs: 0 },
          riskLimitsJson: { maxLots: 5 },
        }),
      });
      toast.success("Copier created");
      void qc.invalidateQueries({ queryKey: ["copiers"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }

  async function control(id: string, action: "start" | "stop") {
    setBusyId(id);
    try {
      await api(`/copiers/${id}/${action}`, { method: "POST", token: token! });
      toast.success(`Copier ${action}`);
      void qc.invalidateQueries({ queryKey: ["copiers"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `${action} failed`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Panel title="Create Trade Copier">
        <div className="space-y-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Master account">
            <Select value={masterId || masters[0]?.id || ""} onChange={(e) => setMasterId(e.target.value)}>
              {masters.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Follower account">
            <Select
              value={followerId || followers[0]?.id || ""}
              onChange={(e) => setFollowerId(e.target.value)}
            >
              {followers.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button variant="primary" className="w-full" loading={creating} onClick={() => void create()}>
            Create copier
          </Button>
        </div>
      </Panel>

      <Panel title="Copiers" className="lg:col-span-2">
        {isLoading ? (
          <div className="py-8 text-center text-sm text-white/35">Loading…</div>
        ) : (
          <div className="space-y-3">
            {(copiers ?? []).map((c) => (
              <div
                key={c.id}
                className="flex flex-col gap-3 rounded-md border border-white/[0.06] p-3 md:flex-row md:items-center md:justify-between"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-white">{c.name}</span>
                    <Badge tone={c.status === "RUNNING" ? "profit" : "neutral"}>{c.status}</Badge>
                  </div>
                  <div className="mt-1 text-[11px] text-white/40">
                    Master {c.masterAccountId.slice(0, 8)}…
                  </div>
                </div>
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    variant="success"
                    loading={busyId === c.id}
                    onClick={() => void control(c.id, "start")}
                  >
                    Start
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={busyId === c.id}
                    onClick={() => void control(c.id, "stop")}
                  >
                    Stop
                  </Button>
                </div>
              </div>
            ))}
            {(copiers ?? []).length === 0 ? (
              <div className="py-8 text-center text-sm text-white/35">No copiers configured</div>
            ) : null}
          </div>
        )}
      </Panel>
    </div>
  );
}
