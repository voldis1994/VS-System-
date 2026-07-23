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
  tradingPinVerified: boolean;
  liveModeRequested: boolean;
  user: AuthUser | null;
  organization: AuthOrganization | null;
  setSession: (payload: {
    accessToken: string;
    user: AuthUser;
    organization?: AuthOrganization | null;
    tradingPinVerified?: boolean;
  }) => void;
  setTradingPinVerified: (verified: boolean, accessToken?: string) => void;
  setLiveModeRequested: (requested: boolean) => void;
  clear: () => void;
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      tradingPinVerified: false,
      liveModeRequested: false,
      user: null,
      organization: null,
      setSession: ({ accessToken, user, organization, tradingPinVerified }) =>
        set({
          accessToken,
          user,
          organization: organization ?? null,
          tradingPinVerified: tradingPinVerified ?? false,
          liveModeRequested: false,
        }),
      setTradingPinVerified: (verified, accessToken) =>
        set((s) => ({
          tradingPinVerified: verified,
          ...(accessToken ? { accessToken } : {}),
        })),
      setLiveModeRequested: (requested) => set({ liveModeRequested: requested }),
      clear: () =>
        set({
          accessToken: null,
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
        user: s.user,
        organization: s.organization,
        tradingPinVerified: s.tradingPinVerified,
      }),
    },
  ),
);
