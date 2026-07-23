"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { useAutomations } from "@/lib/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

export default function AutomationPage() {
  const token = useAuthStore((s) => s.accessToken);
  const { data: automations, isLoading } = useAutomations();
  const qc = useQueryClient();
  const [name, setName] = useState("Close losers at -2R");
  const [trigger, setTrigger] = useState('{"type":"POSITION_PNL"}');
  const [condition, setCondition] = useState('{"op":"lte","value":-2}');
  const [action, setAction] = useState('{"type":"CLOSE_POSITION"}');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function create() {
    setCreating(true);
    try {
      await api("/automations", {
        method: "POST",
        token: token!,
        body: JSON.stringify({
          name,
          triggerJson: JSON.parse(trigger) as unknown,
          conditionTreeJson: JSON.parse(condition) as unknown,
          actionListJson: [JSON.parse(action) as unknown],
          enabled: false,
          cooldownSeconds: 60,
        }),
      });
      toast.success("Automation created");
      void qc.invalidateQueries({ queryKey: ["automations"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }

  async function run(id: string) {
    setBusyId(id);
    try {
      await api(`/automations/${id}/run`, { method: "POST", token: token! });
      toast.success("Automation run triggered");
      void qc.invalidateQueries({ queryKey: ["automations"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Run failed");
    } finally {
      setBusyId(null);
    }
  }

  async function toggle(id: string, enabled: boolean) {
    setBusyId(id);
    try {
      await api(`/automations/${id}`, {
        method: "PATCH",
        token: token!,
        body: JSON.stringify({ enabled: !enabled }),
      });
      toast.success(enabled ? "Disabled" : "Enabled");
      void qc.invalidateQueries({ queryKey: ["automations"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Panel title="Create Automation">
        <div className="space-y-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Trigger JSON">
            <Textarea value={trigger} onChange={(e) => setTrigger(e.target.value)} className="font-mono text-xs" />
          </Field>
          <Field label="Condition JSON">
            <Textarea value={condition} onChange={(e) => setCondition(e.target.value)} className="font-mono text-xs" />
          </Field>
          <Field label="Action JSON">
            <Textarea value={action} onChange={(e) => setAction(e.target.value)} className="font-mono text-xs" />
          </Field>
          <Button variant="primary" className="w-full" loading={creating} onClick={() => void create()}>
            Create
          </Button>
        </div>
      </Panel>

      <Panel title="Automations" className="lg:col-span-2">
        {isLoading ? (
          <div className="py-8 text-center text-sm text-white/35">Loading…</div>
        ) : (
          <div className="space-y-3">
            {(automations ?? []).map((a) => (
              <div
                key={a.id}
                className="flex flex-col gap-3 rounded-md border border-white/[0.06] p-3 md:flex-row md:items-center md:justify-between"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-white">{a.name}</span>
                    <Badge tone={a.enabled ? "profit" : "neutral"}>
                      {a.enabled ? "ENABLED" : "DISABLED"}
                    </Badge>
                  </div>
                  <div className="mt-1 text-[11px] text-white/40">
                    Last run {a.lastRunAt ? new Date(a.lastRunAt).toLocaleString() : "never"}
                  </div>
                </div>
                <div className="flex gap-1.5">
                  <Button size="sm" loading={busyId === a.id} onClick={() => void toggle(a.id, a.enabled)}>
                    {a.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={busyId === a.id}
                    onClick={() => void run(a.id)}
                  >
                    Run now
                  </Button>
                </div>
              </div>
            ))}
            {(automations ?? []).length === 0 ? (
              <div className="py-8 text-center text-sm text-white/35">No automations</div>
            ) : null}
          </div>
        )}
      </Panel>
    </div>
  );
}
