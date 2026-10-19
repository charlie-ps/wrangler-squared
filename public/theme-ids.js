// The Jobs view's themes by id: DOM-free, so server/jobs-schema.js checks a saved
// `theme` against the same list public/themes.js draws. A new theme adds its id here.
export const THEME_IDS = ['wrangler', 'space'];
export const DEFAULT_THEME = 'wrangler';

// Settings saved before themes (they carry `backdrop` or a top-level `plateArt`) keep the look
// they had: a `backdrop` of 'wrangler' was the host's wallpaper, so it opens in the Wrangler
// theme and anything else in Space. Settings with neither get the default. A top-level
// `plateArt` was Space's own option, and its dropped hover mode 'peek' reads as the skyline.
// Leaves an explicit `theme` alone, so a patch naming an unknown one still fails validation.
export function migrateTheme(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return s;
  const { backdrop, plateArt, ...out } = s;
  if (out.theme === undefined) out.theme = backdrop === 'wrangler' ? 'wrangler' : backdrop !== undefined || plateArt !== undefined ? 'space' : DEFAULT_THEME;
  if (plateArt !== undefined && out.themeOptions?.space?.plateArt === undefined) {
    out.themeOptions = { ...out.themeOptions, space: { ...out.themeOptions?.space, plateArt: plateArt === 'peek' ? 'quiet' : plateArt } };
  }
  return out;
}
