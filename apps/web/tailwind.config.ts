import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: {
          950: "#06080C",
          900: "#0E131A",
          800: "#151C26",
          700: "#1E2836",
        },
        accent: {
          DEFAULT: "#D4A574",
          soft: "#E8C49A",
          muted: "rgba(212, 165, 116, 0.14)",
        },
        signal: "#3DDC97",
        profit: "#3DDC97",
        loss: "#FF6B5B",
      },
      fontFamily: {
        sans: ["var(--font-body)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "var(--font-body)", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      boxShadow: {
        glow: "0 0 28px rgba(212, 165, 116, 0.12)",
        signal: "0 0 20px rgba(61, 220, 151, 0.18)",
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
