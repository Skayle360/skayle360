import { NextRequest } from "next/server";
import { adminConfigured, passwordMatches, issueSession, clearSession } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!adminConfigured()) {
    return Response.json({ error: "ADMIN_PASSWORD and ADMIN_SECRET are not configured" }, { status: 500 });
  }
  const { password } = (await req.json().catch(() => ({}))) as { password?: string };
  if (!password || !passwordMatches(password)) {
    // Deliberately vague and deliberately slow — this endpoint is reachable
    // from the internet and a tight loop against it should not be cheap.
    await new Promise((r) => setTimeout(r, 600));
    return Response.json({ error: "Incorrect password" }, { status: 401 });
  }
  const session = issueSession();
  const res = Response.json({ ok: true });
  res.headers.append(
    "set-cookie",
    `${session.name}=${session.value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${session.maxAge}${
      process.env.NODE_ENV === "production" ? "; Secure" : ""
    }`,
  );
  return res;
}

export async function DELETE() {
  const c = clearSession();
  const res = Response.json({ ok: true });
  res.headers.append("set-cookie", `${c.name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return res;
}
