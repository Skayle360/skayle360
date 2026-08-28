/**
 * Widget theme.
 *
 * The brief specified a green accent. The live site does not use green: its
 * stylesheet declares exactly one brand variable, `--orange: #e87722`, against
 * near-black `#201e1b`. "Match the site's look" is the actual requirement, so
 * the verified brand colour wins — but the accent is a single value here, so
 * switching it is one edit if the client wants something else.
 *
 * Verified 2026-08-27 from skayle360-410586.webflow.shared.387501f73.css.
 */
export const THEME = {
  accent: "#e87722",
  accentHover: "#d16a1c",
  accentSoft: "#f5a85c",
  ink: "#201e1b",
  inkMuted: "#6b6560",
  surface: "#ffffff",
  surfaceAlt: "#f7f5f2",
  border: "#e5e0da",
  radius: "14px",
  font: `system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`,
} as const;
