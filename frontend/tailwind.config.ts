import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        panel: "#141821",
        edge: "#232a38",
      },
    },
  },
  plugins: [],
};

export default config;
