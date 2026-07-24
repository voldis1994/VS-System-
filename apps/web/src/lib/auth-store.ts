"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AuthUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  twoFactorEnabled?: boolean;
};

export type AuthOrganization = {
  id: string;
  name: string;
  slug: string;
  timezone?: string;
  defaultCurrency?: string;
};

type AuthState = {
  accessToken: string | null;
  refreshToken: string | null;
  tradingPinVerified: boolean;
  liveModeRequested: boolean;
  user: AuthUser | null;
  organization: AuthOrganization | null;
  setSession: (payload: {
    accessToken: string;
    refreshToken?: string | null;
    user: AuthUser;
    organization?: AuthOrganization | null;
    tradingPinVerified?: boolean;
  }) => void;
  setTokens: (accessToken: string, refreshToken?: string | null) => void;
  setTradingPinVerified: (verified: boolean, accessToken?: string) => void;
  setLiveModeRequested: (requested: boolean) => void;
  clear: () => void;
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      tradingPinVerified: false,
      liveModeRequested: false,
      user: null,
      organization: null,
      setSession: ({
        accessToken,
        refreshToken,
        user,
        organization,
        tradingPinVerified,
      }) =>
        set({
          accessToken,
          refreshToken: refreshToken ?? null,
          user,
          organization: organization ?? null,
          tradingPinVerified: tradingPinVerified ?? false,
          liveModeRequested: false,
        }),
      setTokens: (accessToken, refreshToken) =>
        set((s) => ({
          accessToken,
          refreshToken:
            refreshToken === undefined ? s.refreshToken : refreshToken,
        })),
      setTradingPinVerified: (verified, accessToken) =>
        set((s) => ({
          tradingPinVerified: verified,
          ...(accessToken ? { accessToken } : {}),
        })),
      setLiveModeRequested: (requested) => set({ liveModeRequested: requested }),
      clear: () =>
        set({
          accessToken: null,
          refreshToken: null,
          tradingPinVerified: false,
          liveModeRequested: false,
          user: null,
          organization: null,
        }),
    }),
    {
      name: "nexus-auth",
      partialize: (s) => ({
        accessToken: s.accessToken,
        refreshToken: s.refreshToken,
        user: s.user,
        organization: s.organization,
        tradingPinVerified: s.tradingPinVerified,
      }),
    },
  ),
);
