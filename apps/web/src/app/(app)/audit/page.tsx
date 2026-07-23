"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { useAuditLogs } from "@/lib/hooks";
import { useQueryClient } from "@tanstack/react-query";

export default function AuditPage() {
  const { data: logs, isLoading, isFetching } = useAuditLogs();
  const qc = useQueryClient();

  return (
    <Panel
      title="Audit Log"
      action={
        <Button
          size="sm"
          loading={isFetching}
          onClick={() => void qc.invalidateQueries({ queryKey: ["audit"] })}
        >
          Refresh
        </Button>
      }
    >
      {isLoading ? (
        <div className="py-8 text-center text-sm text-white/35">Loading…</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-white/35">
              <tr className="border-b border-white/[0.06]">
                <th className="pb-2 pr-3 font-medium">Time</th>
                <th className="pb-2 pr-3 font-medium">Action</th>
                <th className="pb-2 pr-3 font-medium">Resource</th>
                <th className="pb-2 pr-3 font-medium">Actor</th>
                <th className="pb-2 font-medium">Correlation</th>
              </tr>
            </thead>
            <tbody>
              {(logs ?? []).map((l) => (
                <tr key={l.id} className="border-b border-white/[0.04]">
                  <td className="py-2 pr-3 font-mono text-white/50">
                    {new Date(l.createdAt).toLocaleString()}
                  </td>
                  <td className="py-2 pr-3">
                    <Badge tone="accent">{l.action}</Badge>
                  </td>
                  <td className="py-2 pr-3 text-white/70">
                    {l.resourceType}
                    {l.resourceId ? (
                      <span className="ml-1 font-mono text-white/35">
                        {l.resourceId.slice(0, 8)}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 font-mono text-white/45">
                    {l.actorId ? l.actorId.slice(0, 8) : "system"}
                  </td>
                  <td className="py-2 font-mono text-white/30">{l.correlationId.slice(0, 12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(logs ?? []).length === 0 ? (
            <div className="py-8 text-center text-sm text-white/35">No audit events</div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
