// GENERATED FILE - DO NOT EDIT.
// Source: cronixui/packages/web/dist/variables.css (:root block)
// Regenerate: npm run gen:theme -w @actor0/cli
// Verified by: src/theme.test.ts
//
// CronixUI is the design system of record for this CLI. These are its dark
// theme tokens, with translucent values composited onto --cn-bg because a
// terminal cell cannot be translucent. Nothing here is chosen by hand.

export const cronix = {
  "color": {
    "bg": "#0a0a0a",
    "surface": "#111111",
    "surface2": "#1a1a1a",
    "surface3": "#222222",
    "surface4": "#2a2a2a",
    "border": "#1e1e1e",
    "borderHover": "#2f2f2f",
    "borderFocus": "#474747",
    "text": "#f0ede8",
    "textMuted": "#7d7c79",
    "textDim": "#444342",
    "accent": "#6b2323",
    "accentHover": "#7d2a2a",
    "accentLight": "#8a3535",
    "accentGlow": "#271212",
    "accentText": "#c97a7a",
    "success": "#1e5028",
    "successBorder": "#1e3e22",
    "successText": "#6bc47a",
    "warning": "#503c14",
    "warningBorder": "#423212",
    "warningText": "#c4a43a",
    "error": "#501414",
    "errorBorder": "#4e1e1e",
    "errorText": "#c46b6b",
    "info": "#143550",
    "infoBorder": "#1e3e56",
    "infoText": "#6ba8c4"
  },
  "space": {
    "1": 4,
    "2": 8,
    "3": 12,
    "4": 16,
    "5": 20,
    "6": 24,
    "8": 32,
    "10": 40,
    "12": 48
  },
  "fontSize": {
    "xs": 11,
    "sm": 12,
    "base": 13,
    "md": 14,
    "lg": 16,
    "xl": 20,
    "2xl": 28,
    "3xl": 36
  },
  "transition": {
    "fast": 100,
    "base": 150,
    "slow": 250
  }
} as const;

export type CronixTheme = typeof cronix;
