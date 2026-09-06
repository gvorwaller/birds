/** Fixed, reviewed palettes only. Never accept CSS supplied by a user. */
const light = {
  bg: "#f8f9fa",
  card: "#ffffff",
  border: "#79848c",
  text: "#212529",
  muted: "#424a52",
  accent: "#0a5940",
  "accent-soft": "#e3f3ec",
  "on-accent": "#ffffff",
  link: "#084298",
  "need-bg": "#fff3cd",
  "need-text": "#5c4400",
  "seen-bg": "#d1e7dd",
  "seen-text": "#0a3622",
  "notable-bg": "#f8d7da",
  "notable-text": "#58151c",
  danger: "#842029",
  "on-danger": "#ffffff",
  "danger-soft": "#fdf0f1",
  "danger-border": "#a85c66",
  "info-bg": "#dcebf7",
  "info-text": "#163e5e",
  "info-border": "#789bb6",
  "tag-text": "#1d4a35",
  "tag-border": "#789783",
  "nav-bg": "#ffffff",
  "placeholder-bg": "#dde3e8",
  "ribbon-0": "#eceff1",
  "ribbon-1": "#cfe9dc",
  "ribbon-2": "#9fd0b8",
  "ribbon-3": "#63ad8b",
  "ribbon-4": "#2f855f",
  "ribbon-5": "#0a5940",
  "ribbon-slash": "#6c757d",
};
type Palette = typeof light;
export const THEMES = [
  {
    id: "light",
    name: "Light",
    description: "Clean white with classic birding green.",
    scheme: "light",
    colors: light,
  },
  {
    id: "dark",
    name: "Dark",
    description: "Deep charcoal with soft, high-contrast text.",
    scheme: "dark",
    colors: {
      ...light,
      bg: "#101820",
      card: "#19232c",
      border: "#708393",
      text: "#f2f6fa",
      muted: "#c2cfdb",
      accent: "#a8e8c8",
      "accent-soft": "#223e32",
      "on-accent": "#102a20",
      link: "#bbd9ff",
      "need-bg": "#382f18",
      "need-text": "#ffe6a5",
      "seen-bg": "#203b2e",
      "seen-text": "#bfeacf",
      "notable-bg": "#401f2a",
      "notable-text": "#ffd1d8",
      danger: "#ffbac2",
      "on-danger": "#39131a",
      "danger-soft": "#401f2a",
      "danger-border": "#b57c87",
      "info-bg": "#20374b",
      "info-text": "#d3e9ff",
      "info-border": "#789bb6",
      "tag-text": "#bfeacf",
      "tag-border": "#789783",
      "nav-bg": "#19232c",
      "placeholder-bg": "#30404e",
      "ribbon-0": "#28323a",
      "ribbon-1": "#294737",
      "ribbon-2": "#376249",
      "ribbon-3": "#528963",
      "ribbon-4": "#7cb28e",
      "ribbon-5": "#a8e8c8",
      "ribbon-slash": "#c2cfdb",
    },
  },
  {
    id: "forest",
    name: "Forest",
    description: "Soft green surfaces and deep woodland accents.",
    scheme: "light",
    colors: {
      ...light,
      bg: "#eaf1e7",
      card: "#f7faf3",
      text: "#17291d",
      muted: "#354b3b",
      accent: "#194b2c",
      "accent-soft": "#dcebd7",
      link: "#17436b",
      "nav-bg": "#f7faf3",
    },
  },
  {
    id: "ocean",
    name: "Ocean",
    description: "Cool blue surfaces and coastal blue accents.",
    scheme: "light",
    colors: {
      ...light,
      bg: "#eaf2f8",
      card: "#f8fbff",
      text: "#142b3d",
      muted: "#354d60",
      accent: "#124968",
      "accent-soft": "#d9eaf5",
      link: "#124968",
      "nav-bg": "#f8fbff",
    },
  },
  {
    id: "paper",
    name: "Warm Paper",
    description: "Warm cream surfaces with ink-and-earth accents.",
    scheme: "light",
    colors: {
      ...light,
      bg: "#f3ead7",
      card: "#fff8e9",
      text: "#332819",
      muted: "#514331",
      accent: "#573712",
      "accent-soft": "#eddfc2",
      link: "#493862",
      "nav-bg": "#fff8e9",
    },
  },
] as const satisfies readonly {
  id: string;
  name: string;
  description: string;
  scheme: string;
  colors: Palette;
}[];
export type ThemeId = (typeof THEMES)[number]["id"];
export const DEFAULT_THEME: ThemeId = "light";
export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && THEMES.some((t) => t.id === value);
}
export function themeDefinition(id: ThemeId) {
  return THEMES.find((t) => t.id === id)!;
}
export function themeStyle(id: ThemeId): string {
  const theme = themeDefinition(id);
  return (
    `color-scheme:${theme.scheme};` +
    Object.entries(theme.colors)
      .map(([k, v]) => `--${k}:${v}`)
      .join(";")
  );
}

/** Exact exception for viewers: no private settings, arbitrary actions or paths. */
export function isAppearanceRequest(
  path: string,
  method: string,
  firstAction?: string,
): boolean {
  return (
    path === "/settings/appearance" &&
    (method === "GET" ||
      method === "HEAD" ||
      (method === "POST" && firstAction === "/save_theme"))
  );
}
