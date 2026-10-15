import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: "#0A0A0B",
        charcoal: "#15151A",
        "charcoal-light": "#1F1F24",
        hairline: "#2B2B2E",
        bone: "#F1F1EF",
        stone: "#9B9B98",
        accent: {
          DEFAULT: "#FFFFFF",
          dim: "#D6D6D4",
        },
      },
      fontFamily: {
        display: ["var(--font-fraunces)", "serif"],
        sans: ["var(--font-inter)", "sans-serif"],
      },
      letterSpacing: {
        widest2: "0.28em",
      },
      maxWidth: {
        content: "1280px",
      },
      keyframes: {
        fadeUp: {
          "0%": { opacity: "0", transform: "translateY(24px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
      },
      animation: {
        fadeUp: "fadeUp 0.9s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        fadeIn: "fadeIn 1.1s ease forwards",
      },
    },
  },
  plugins: [],
};
export default config;
