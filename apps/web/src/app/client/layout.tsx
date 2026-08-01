import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ClientPwaRegister } from "./pwa-register";

export const metadata: Metadata = {
  title: "VS Client",
  description: "VS System — klienta telefona portāls",
  applicationName: "VS Client",
  manifest: "/manifest-client.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "VS Client",
  },
  icons: {
    icon: [
      { url: "/client-icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/client-icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/client-icons/icon-180.png", sizes: "180x180", type: "image/png" }],
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: "#03050a",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function ClientLayout({ children }: { children: ReactNode }) {
  return (
    <div className="client-app-root min-h-[100dvh] bg-[#03050a] text-[#e8f1f8]">
      <ClientPwaRegister />
      {children}
    </div>
  );
}
