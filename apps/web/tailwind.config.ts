import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: {
          950: "#070B10",
          900: "#101820",
          800: "#15202B",
          700: "#1C2A38",
        },
        accent: {
          DEFAULT: "#C9A227",
          soft: "#E4C45A",
          muted: "rgba(201, 162, 39, 0.14)",
        },
        signal: "#2ECF8F",
        profit: "#2ECF8F",
        loss: "#F07167",
      },
      fontFamily: {
        sans: ["var(--font-body)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "var(--font-body)", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      boxShadow: {
        glow: "0 0 32px rgba(201, 162, 39, 0.14)",
        signal: "0 0 20px rgba(46, 207, 143, 0.16)",
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
