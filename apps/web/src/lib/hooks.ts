"use client";

import { useAuthStore } from "@/lib/auth-store";
import { api } from "@/lib/api";
import type {
  Alert,
  AnalyticsOverview,
  Automation,
  AuditLog,
  Copier,
  JournalEntry,
  MarketTick,
  Notification,
  Order,
  Position,
  ReportJob,
  RiskProfile,
  Strategy,
  TradingAccount,
} from "@/lib/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

function useToken() {
  return useAuthStore((s) => s.accessToken);
}

export function useAccounts() {
  const token = useToken();
  return useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<TradingAccount[]>("/accounts", { token: token! }),
    enabled: !!token,
    refetchInterval: 15_000,
  });
}

export function usePositions() {
  const token = useToken();
  return useQuery({
    queryKey: ["positions"],
    queryFn: () => api<Position[]>("/positions", { token: token! }),
    enabled: !!token,
    refetchInterval: 5000,
  });
}

export function useOrders() {
  const token = useToken();
  return useQuery({
    queryKey: ["orders"],
    queryFn: () => api<Order[]>("/orders", { token: token! }),
    enabled: !!token,
    refetchInterval: 6000,
  });
}

export function useTicks() {
  const token = useToken();
  return useQuery({
    queryKey: ["ticks"],
    queryFn: () => api<MarketTick[]>("/market-data/ticks", { token: token! }),
    enabled: !!token,
    refetchInterval: 2000,
  });
}

export function useAnalytics() {
  const token = useToken();
  return useQuery({
    queryKey: ["analytics-overview"],
    queryFn: () => api<AnalyticsOverview>("/analytics/overview", { token: token! }),
    enabled: !!token,
    refetchInterval: 10_000,
  });
}

export function useNotifications() {
  const token = useToken();
  return useQuery({
    queryKey: ["notifications"],
    queryFn: () => api<Notification[]>("/notifications", { token: token! }),
    enabled: !!token,
    refetchInterval: 10_000,
  });
}

export function useStrategies() {
  const token = useToken();
  return useQuery({
    queryKey: ["strategies"],
    queryFn: () => api<Strategy[]>("/strategies", { token: token! }),
    enabled: !!token,
    refetchInterval: 4000,
  });
}

export function useRiskProfiles() {
  const token = useToken();
  return useQuery({
    queryKey: ["risk-profiles"],
    queryFn: () => api<RiskProfile[]>("/risk/profiles", { token: token! }),
    enabled: !!token,
  });
}

export function useCopiers() {
  const token = useToken();
  return useQuery({
    queryKey: ["copiers"],
    queryFn: () => api<Copier[]>("/copiers", { token: token! }),
    enabled: !!token,
    refetchInterval: 5000,
  });
}

export function useAutomations() {
  const token = useToken();
  return useQuery({
    queryKey: ["automations"],
    queryFn: () => api<Automation[]>("/automations", { token: token! }),
    enabled: !!token,
    refetchInterval: 5000,
  });
}

export function useAlerts() {
  const token = useToken();
  return useQuery({
    queryKey: ["alerts"],
    queryFn: () => api<Alert[]>("/alerts", { token: token! }),
    enabled: !!token,
    refetchInterval: 5000,
  });
}

export function useAuditLogs() {
  const token = useToken();
  return useQuery({
    queryKey: ["audit"],
    queryFn: () => api<AuditLog[]>("/audit", { token: token! }),
    enabled: !!token,
  });
}

export function useJournal() {
  const token = useToken();
  return useQuery({
    queryKey: ["journal"],
    queryFn: () => api<JournalEntry[]>("/journal", { token: token! }),
    enabled: !!token,
  });
}

export function useReports() {
  const token = useToken();
  return useQuery({
    queryKey: ["reports"],
    queryFn: () => api<ReportJob[]>("/reports", { token: token! }),
    enabled: !!token,
    refetchInterval: 5000,
  });
}

export function useInvalidateTrading() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["accounts"] });
    void qc.invalidateQueries({ queryKey: ["positions"] });
    void qc.invalidateQueries({ queryKey: ["orders"] });
    void qc.invalidateQueries({ queryKey: ["analytics-overview"] });
  };
}

export function useApiMutation<TBody, TResult = unknown>(
  pathFn: (body: TBody) => { path: string; method?: string; body?: unknown },
  opts?: { invalidate?: string[][]; onSuccess?: (data: TResult) => void },
) {
  const token = useToken();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: TBody) => {
      const { path, method = "POST", body: payload } = pathFn(body);
      return api<TResult>(path, {
        method,
        token: token!,
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
    },
    onSuccess: (data) => {
      for (const key of opts?.invalidate ?? []) {
        void qc.invalidateQueries({ queryKey: key });
      }
      opts?.onSuccess?.(data);
    },
  });
}
