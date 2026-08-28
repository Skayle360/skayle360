import { NextRequest } from "next/server";
import { isAuthenticated } from "../../../../lib/admin-auth";
import { EDITABLE, loadSettings, saveSetting, resetSetting, type SettingKey } from "../../../../lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deny = () => Response.json({ error: "unauthorized" }, { status: 401 });

export async function GET(req: NextRequest) {
  if (!isAuthenticated(req)) return deny();
  const values = await loadSettings();
  return Response.json({
    settings: Object.entries(EDITABLE).map(([key, def]) => ({
      key,
      label: def.label,
      help: def.help,
      value: values[key as SettingKey],
      isDefault: values[key as SettingKey] === def.default,
      presets: "presets" in def ? def.presets : null,
    })),
  });
}

export async function PUT(req: NextRequest) {
  if (!isAuthenticated(req)) return deny();
  const { key, value } = (await req.json().catch(() => ({}))) as { key?: string; value?: string };
  if (!key || !(key in EDITABLE)) return Response.json({ error: "unknown setting" }, { status: 400 });
  if (typeof value !== "string" || !value.trim()) {
    return Response.json({ error: "value cannot be empty" }, { status: 400 });
  }
  if (value.length > 8000) return Response.json({ error: "value is too long" }, { status: 400 });
  await saveSetting(key as SettingKey, value.trim(), "admin");
  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  if (!isAuthenticated(req)) return deny();
  const { key } = (await req.json().catch(() => ({}))) as { key?: string };
  if (!key || !(key in EDITABLE)) return Response.json({ error: "unknown setting" }, { status: 400 });
  await resetSetting(key as SettingKey);
  return Response.json({ ok: true });
}
