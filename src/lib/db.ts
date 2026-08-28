import { Pool } from "pg";
import { setDefaultResultOrder } from "node:dns";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

// Neon resolves to both IPv6 and IPv4. Node tries IPv6 first by default, and on
// a host without an IPv6 route that attempt fails with ENETUNREACH after
// consuming most of the connection timeout. Prefer IPv4 so the first attempt is
// the one that can succeed.
try {
  setDefaultResultOrder("ipv4first");
  // Node races the address families and allows each attempt only 250ms by
  // default. A managed Postgres in another region takes longer than that to
  // complete a handshake, so every attempt "times out" and the connection
  // fails with ETIMEDOUT against an address that is in fact reachable.
  setDefaultAutoSelectFamilyAttemptTimeout(
    Number(process.env.PGCONNECT_ATTEMPT_TIMEOUT_MS ?? 5_000),
  );
} catch {
  // Older runtimes without these settings; the defaults still work locally.
}

let pool: Pool | null = null;

export function db(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new Pool({
      connectionString,
      // Neon and Supabase both terminate idle connections aggressively; a small
      // pool with a short idle timeout is what survives serverless invocation.
      max: Number(process.env.PGPOOL_MAX ?? 5),
      idleTimeoutMillis: 10_000,
      // Serverless Postgres scales to zero, so the first connection after an
      // idle period has to wake the compute. Eight seconds was not enough and
      // surfaced as an opaque ETIMEDOUT on the first request of the day.
      connectionTimeoutMillis: Number(process.env.PGCONNECT_TIMEOUT_MS ?? 30_000),
      ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? undefined : { rejectUnauthorized: true },
    });
  }
  return pool;
}
