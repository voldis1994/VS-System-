import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: {
          950: "#02040A",
          900: "#070D16",
          800: "#0C1522",
          700: "#142033",
        },
        accent: {
          DEFAULT: "#00F0FF",
          soft: "#7AF6FF",
          muted: "rgba(0, 240, 255, 0.16)",
        },
        signal: "#39FF14",
        profit: "#39FF14",
        loss: "#FF2D55",
      },
      fontFamily: {
        sans: ["var(--font-body)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "var(--font-body)", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      boxShadow: {
        glow: "0 0 32px rgba(0, 240, 255, 0.35)",
        signal: "0 0 22px rgba(57, 255, 20, 0.28)",
        neon: "0 0 24px rgba(0, 240, 255, 0.4), 0 0 48px rgba(255, 43, 214, 0.12)",
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
