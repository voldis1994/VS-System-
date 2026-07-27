import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: {
          950: "#03050A",
          900: "#0A1018",
          800: "#101820",
          700: "#182430",
        },
        accent: {
          DEFAULT: "#5EE7FF",
          soft: "#9AF0FF",
          muted: "rgba(94, 231, 255, 0.14)",
        },
        signal: "#3DFF9A",
        profit: "#3DFF9A",
        loss: "#FF5D6C",
      },
      fontFamily: {
        sans: ["var(--font-body)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "var(--font-body)", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      boxShadow: {
        glow: "0 0 28px rgba(94, 231, 255, 0.22)",
        signal: "0 0 20px rgba(61, 255, 154, 0.18)",
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
