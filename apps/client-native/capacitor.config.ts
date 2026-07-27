import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Native shell for VS Client.
 * Set CLIENT_APP_URL to your deployed HTTPS origin (e.g. https://app.example.com).
 * The WebView opens /client as a standalone phone app.
 */
const serverUrl = (process.env.CLIENT_APP_URL || "").replace(/\/$/, "");

const config: CapacitorConfig = {
  appId: "lv.vssystem.client",
  appName: "VS Client",
  webDir: "www",
  server: serverUrl
    ? {
        url: `${serverUrl}/client`,
        cleartext: serverUrl.startsWith("http://"),
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
