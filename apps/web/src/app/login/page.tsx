"use client";

import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAuthStore, type AuthOrganization, type AuthUser } from "@/lib/auth-store";
import { RegisterSchema } from "@nexus/domain";
import { zodResolver } from "@hookform/resolvers/zod";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

const LoginFormSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  organizationSlug: z.string().max(64).optional(),
});

type LoginValues = z.infer<typeof LoginFormSchema>;
type RegisterValues = z.infer<typeof RegisterSchema>;

type AuthResponse = {
  accessToken?: string;
  requires2FA?: boolean;
  challengeToken?: string;
  user: AuthUser;
  organization?: AuthOrganization;
  tradingPinVerified?: boolean;
};

export default function LoginPage() {
  const [tab, setTab] = useState<"login" | "register">("login");
  const token = useAuthStore((s) => s.accessToken);
  const setSession = useAuthStore((s) => s.setSession);
  const router = useRouter();

  useEffect(() => {
    if (token) router.replace("/dashboard");
  }, [token, router]);

  const loginForm = useForm<LoginValues>({
    resolver: zodResolver(LoginFormSchema),
    defaultValues: { email: "", password: "", organizationSlug: "" },
  });

  const registerForm = useForm<RegisterValues>({
    resolver: zodResolver(RegisterSchema),
    defaultValues: {
      email: "",
      password: "",
      firstName: "",
      lastName: "",
      organizationName: "",
      organizationSlug: "",
      timezone: "UTC",
      defaultCurrency: "USD",
      tradingPin: "",
    },
  });

  async function onLogin(values: LoginValues) {
    try {
      const payload = {
        email: values.email,
        password: values.password,
        ...(values.organizationSlug ? { organizationSlug: values.organizationSlug } : {}),
      };
      const res = await api<AuthResponse>("/auth/login", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (res.requires2FA) {
        toast.message("2FA required — complete verification to continue");
        return;
      }
      if (!res.accessToken) throw new Error("No access token returned");
      setSession({
        accessToken: res.accessToken,
        user: res.user,
        organization: res.organization ?? null,
        tradingPinVerified: res.tradingPinVerified ?? false,
      });
      toast.success("Welcome back");
      router.replace("/dashboard");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Login failed");
    }
  }

  async function onRegister(values: RegisterValues) {
    try {
      const res = await api<AuthResponse>("/auth/register", {
        method: "POST",
        body: JSON.stringify(values),
      });
      if (!res.accessToken) throw new Error("No access token returned");
      setSession({
        accessToken: res.accessToken,
        user: res.user,
        organization: res.organization ?? null,
        tradingPinVerified: false,
      });
      toast.success("Organization created");
      router.replace("/dashboard");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Registration failed");
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(139,92,246,0.18),_transparent_55%)]" />
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative w-full max-w-md rounded-xl border border-white/10 bg-navy-900/85 p-6 shadow-glow backdrop-blur"
      >
        <div className="mb-6 text-center">
          <div className="font-sans text-3xl font-bold tracking-tight text-white">
            NEXUS <span className="text-accent">PRO</span>
          </div>
          <p className="mt-2 text-sm text-white/45">Multi-account trading command center</p>
        </div>

        <div className="mb-5 grid grid-cols-2 gap-1 rounded-md bg-white/5 p-1">
          <button
            type="button"
            className={`rounded px-3 py-2 text-sm font-medium ${tab === "login" ? "bg-accent text-white" : "text-white/50"}`}
            onClick={() => setTab("login")}
          >
            Login
          </button>
          <button
            type="button"
            className={`rounded px-3 py-2 text-sm font-medium ${tab === "register" ? "bg-accent text-white" : "text-white/50"}`}
            onClick={() => setTab("register")}
          >
            Register
          </button>
        </div>

        {tab === "login" ? (
          <form className="space-y-3" onSubmit={loginForm.handleSubmit(onLogin)}>
            <Field label="Email">
              <Input type="email" autoComplete="email" {...loginForm.register("email")} />
            </Field>
            <Field label="Password">
              <Input type="password" autoComplete="current-password" {...loginForm.register("password")} />
            </Field>
            <Field label="Organization slug (optional)">
              <Input {...loginForm.register("organizationSlug")} />
            </Field>
            <Button
              type="submit"
              variant="primary"
              className="w-full"
              loading={loginForm.formState.isSubmitting}
            >
              Sign in
            </Button>
          </form>
        ) : (
          <form className="space-y-3" onSubmit={registerForm.handleSubmit(onRegister)}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="First name">
                <Input {...registerForm.register("firstName")} />
              </Field>
              <Field label="Last name">
                <Input {...registerForm.register("lastName")} />
              </Field>
            </div>
            <Field label="Email">
              <Input type="email" {...registerForm.register("email")} />
            </Field>
            <Field label="Password">
              <Input type="password" {...registerForm.register("password")} />
            </Field>
            <Field label="Organization name">
              <Input {...registerForm.register("organizationName")} />
            </Field>
            <Field label="Organization slug">
              <Input placeholder="acme-trading" {...registerForm.register("organizationSlug")} />
            </Field>
            <Field label="Trading PIN (6 digits)">
              <Input
                inputMode="numeric"
                maxLength={6}
                {...registerForm.register("tradingPin")}
              />
            </Field>
            {Object.values(registerForm.formState.errors)[0]?.message ? (
              <p className="text-xs text-loss">
                {String(Object.values(registerForm.formState.errors)[0]?.message)}
              </p>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              className="w-full"
              loading={registerForm.formState.isSubmitting}
            >
              Create account
            </Button>
          </form>
        )}
      </motion.div>
    </div>
  );
}
