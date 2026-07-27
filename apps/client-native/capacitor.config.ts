import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Native shell for VS Client (iPhone).
 *
 * CLIENT_APP_URL = Tava Windows PC adrese, piem.:
 *   export CLIENT_APP_URL="http://192.168.1.50:3000"
 * WebView atver /client un runā pret to pašu serveri.
 */
const serverUrl = (process.env.CLIENT_APP_URL || "").replace(/\/$/, "");

const config: CapacitorConfig = {
  appId: "lv.vssystem.client",
  appName: "VS Client",
  webDir: "www",
  server: serverUrl
    ? {
        url: `${serverUrl}/client`,
        cleartext: true,
        allowNavigation: ["*"],
      }
    : undefined,
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: "#07090c",
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#07090c",
    },
  },
  ios: {
    contentInset: "automatic",
    preferredContentMode: "mobile",
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
