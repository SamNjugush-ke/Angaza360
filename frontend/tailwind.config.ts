import type { Config } from "tailwindcss";
import defaultTheme from "tailwindcss/defaultTheme";
import animate from "tailwindcss-animate";

/** A colour read from a channel-triplet variable in app/globals.css, the ONE token source. */
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{js,ts,jsx,tsx,mdx}", "./components/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // The brand palette (brand-kit/07_Palette_And_Design_Tokens), through its variables.
        angaza: {
          primary: token("angaza-primary"),
          support: token("angaza-support-teal"),
          lightTeal: token("angaza-light-teal"),
          gold: token("angaza-gold"),
          warm: token("angaza-warm"),
          navy: token("angaza-navy"),
          success: token("angaza-success"),
          warning: token("angaza-warning"),
          danger: token("angaza-danger"),
          white: token("angaza-white"),
          black: token("angaza-black"),
        },
        // The semantic set: shadcn/ui's names plus success / warning / danger.
        background: token("background"),
        foreground: token("foreground"),
        card: { DEFAULT: token("card"), foreground: token("card-foreground") },
        popover: { DEFAULT: token("popover"), foreground: token("popover-foreground") },
        primary: { DEFAULT: token("primary"), foreground: token("primary-foreground") },
        secondary: { DEFAULT: token("secondary"), foreground: token("secondary-foreground") },
        muted: { DEFAULT: token("muted"), foreground: token("muted-foreground") },
        accent: { DEFAULT: token("accent"), foreground: token("accent-foreground") },
        destructive: { DEFAULT: token("destructive"), foreground: token("destructive-foreground") },
        border: token("border"),
        input: token("input"),
        ring: token("ring"),
        success: token("success"),
        warning: token("warning"),
        danger: token("danger"),
      },
      // text-success is small text, so it reads the AA text token; bg-/border-success keep
      // the brand success fill.
      textColor: {
        success: token("success-text"),
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", ...defaultTheme.fontFamily.sans],
        display: ["var(--font-display)", ...defaultTheme.fontFamily.sans],
        mono: ["var(--font-mono)", ...defaultTheme.fontFamily.mono],
      },
    },
  },
  plugins: [animate],
};

export default config;
