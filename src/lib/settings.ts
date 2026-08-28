import { db } from "./db";
import { CONTENT_DEPTH_POLICY, LEAD_CAPTURE_MODES, LEAD_CAPTURE_POLICY } from "./prompt";
import { recordVersion } from "./versions";

/**
 * Prompt blocks the admin page may change, and their code defaults.
 *
 * Deliberately a short list. The grounding rules, the citation requirement, the
 * eligibility disclaimer and the scope limits are NOT here — they stay in
 * src/lib/prompt.ts where nothing at runtime can edit them. Those rules are the
 * product; an editable copy of them is a way to switch the product off by
 * accident, with nothing looking broken afterwards.
 */
export const EDITABLE = {
  content_depth: {
    label: "How much course content to give away",
    help: "The client asked for a short summary then a booking. Loosen or tighten here.",
    default: CONTENT_DEPTH_POLICY,
  },
  lead_capture: {
    label: "How hard to ask for contact details",
    help: "passive = never asks · balanced = asks once after helping · forward = treats it as the goal.",
    default: LEAD_CAPTURE_POLICY,
    presets: LEAD_CAPTURE_MODES as Record<string, string>,
  },
  style: {
    label: "Tone and length",
    help: "Voice, paragraph count, and how many calls to action per message.",
    default: `Direct and warm. Short paragraphs; a phone screen is narrow. No exclamation marks, no "Great question!", no consultant filler. Numbers and specifics beat adjectives.

Length: one short paragraph answers most questions. Two is the ceiling. Three only if they asked something genuinely multi-part.

End with one call to action, never two, and not on every message.`,
  },
} as const;

export type SettingKey = keyof typeof EDITABLE;

let cache: { at: number; values: Record<string, string> } | null = null;
const TTL_MS = 30_000;

/**
 * Cached for half a minute. The prompt is the cached prefix on every request,
 * so reading three rows from Postgres per message would add latency to every
 * turn for a value that changes a few times a year.
 */
export async function loadSettings(): Promise<Record<SettingKey, string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.values as Record<SettingKey, string>;
  const values: Record<string, string> = {};
  for (const [key, def] of Object.entries(EDITABLE)) values[key] = def.default;
  try {
    const { rows } = await db().query<{ key: string; value: string }>("SELECT key, value FROM settings");
    for (const r of rows) if (r.key in EDITABLE) values[r.key] = r.value;
  } catch (err) {
    // A settings outage must not take the chat down; the code defaults are valid.
    console.error("[settings] falling back to defaults:", err instanceof Error ? err.message : err);
  }
  cache = { at: Date.now(), values };
  return values as Record<SettingKey, string>;
}

export async function saveSetting(key: SettingKey, value: string, who: string, restoredFrom?: string): Promise<void> {
  // Keep what is being replaced, so an edit can be undone.
  const current = (await loadSettings())[key];
  if (current !== value) await recordVersion(key, current, who, restoredFrom);
  await db().query(
    `INSERT INTO settings (key, value, updated_by) VALUES ($1,$2,$3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, value, who],
  );
  cache = null;
}

export async function resetSetting(key: SettingKey): Promise<void> {
  await db().query("DELETE FROM settings WHERE key = $1", [key]);
  cache = null;
}
