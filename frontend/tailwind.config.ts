import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // 深石墨工作台配色
        bg: "#0b0d10",
        rail: "#08090b",
        surface: "#14171c",
        surface2: "#191d24",
        edge: "#23262d",
        ink: "#e6e8ee",
        muted: "#8b93a1",
        accent: "#7c5cff",
        accentSoft: "#9d86ff",
        ok: "#3ecf8e",
        bad: "#ff6b6b",
        warn: "#f5b544",
      },
      borderRadius: {
        xl2: "14px",
      },
      boxShadow: {
        pop: "0 18px 60px rgba(0,0,0,0.5)",
      },
    },
  },
  plugins: [],
};

export default config;
