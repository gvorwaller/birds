import { describe, it, expect } from "vitest";
import { THEMES, isThemeId, isAppearanceRequest, themeStyle } from "./themes";
function luminance(hex: string) {
  const rgb = hex
    .slice(1)
    .match(/../g)!
    .map((n) => parseInt(n, 16) / 255)
    .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a: string, b: string) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
describe("account themes", () => {
  it("accepts only the five explicit IDs, never arbitrary CSS", () => {
    expect(THEMES.map((t) => t.id)).toEqual([
      "light",
      "dark",
      "forest",
      "ocean",
      "paper",
    ]);
    for (const value of [
      "",
      "system",
      "DARK",
      "dark; color:red",
      null,
      {},
      "__proto__",
    ])
      expect(isThemeId(value)).toBe(false);
    for (const t of THEMES) expect(isThemeId(t.id)).toBe(true);
  });
  for (const t of THEMES)
    it(`${t.name} has complete palettes and AAA text pairs`, () => {
      expect(Object.keys(t.colors).sort()).toEqual(
        Object.keys(THEMES[0].colors).sort(),
      );
      const pairs: [keyof typeof t.colors, keyof typeof t.colors][] = [
        ["text", "bg"],
        ["text", "card"],
        ["muted", "bg"],
        ["muted", "card"],
        ["accent", "bg"],
        ["accent", "card"],
        ["accent", "accent-soft"],
        ["link", "bg"],
        ["link", "card"],
        ["on-accent", "accent"],
        ["on-danger", "danger"],
        ["danger", "card"],
        ["danger", "danger-soft"],
        ["need-text", "need-bg"],
        ["seen-text", "seen-bg"],
        ["notable-text", "notable-bg"],
        ["info-text", "info-bg"],
        ["info-text", "card"],
        ["tag-text", "accent-soft"],
        ["tag-text", "bg"],
      ];
      for (const [fg, bg] of pairs)
        expect(
          contrast(t.colors[fg], t.colors[bg]),
          `${t.id}: ${fg}/${bg}`,
        ).toBeGreaterThanOrEqual(7);
      expect(themeStyle(t.id)).toContain(`color-scheme:${t.scheme}`);
      expect(themeStyle(t.id)).not.toMatch(/["<>]/);
    });
  it("allows viewers only the exact appearance page and its save action", () => {
    for (const method of ["GET", "HEAD"])
      expect(isAppearanceRequest("/settings/appearance", method)).toBe(true);
    expect(
      isAppearanceRequest("/settings/appearance", "POST", "/save_theme"),
    ).toBe(true);
    for (const path of [
      "/settings",
      "/settings/appearance/private",
      "/settings/appearancex",
    ])
      expect(isAppearanceRequest(path, "POST", "/save_theme")).toBe(false);
    for (const action of [
      "/save_api_key",
      "/save_home",
      "/delete_user",
      "foo",
      undefined,
    ])
      expect(isAppearanceRequest("/settings/appearance", "POST", action)).toBe(
        false,
      );
    expect(
      isAppearanceRequest("/settings/appearance", "DELETE", "/save_theme"),
    ).toBe(false);
  });
});
