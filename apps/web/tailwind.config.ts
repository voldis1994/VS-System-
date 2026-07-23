import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: {
          950: "#05070F",
          900: "#0B1220",
          800: "#111827",
          700: "#1A2332",
        },
        accent: {
          DEFAULT: "#8B5CF6",
          soft: "#A78BFA",
          muted: "rgba(139, 92, 246, 0.15)",
        },
        profit: "#22C55E",
        loss: "#EF4444",
      },
      fontFamily: {
        sans: ["var(--font-ibm-plex-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-ibm-plex-mono)", "ui-monospace", "monospace"],
      },
      boxShadow: {
        glow: "0 0 24px rgba(139, 92, 246, 0.18)",
      },
      animation: {
        "pulse-live": "pulse-live 2s ease-in-out infinite",
      },
      keyframes: {
        "pulse-live": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.45" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
