import { ALLOWED_ORIGINS } from "../../config/app";

/**
 * Not a public page — this host only serves the widget and its API. Kept as a
 * one-screen operator note so someone landing here knows what this is.
 */
export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "3rem", maxWidth: "44rem", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: "1.4rem" }}>SCALE UP assistant</h1>
      <p>Chat backend and embeddable widget for skayle360.com.</p>
      <p>Embed with a single tag in Webflow &rsaquo; Site Settings &rsaquo; Custom Code &rsaquo; Footer:</p>
      <pre style={{ background: "#f5f5f5", padding: "1rem", borderRadius: 8, overflowX: "auto" }}>
        {`<script src="https://chat.skayle360.com/widget.js" defer></script>`}
      </pre>
      <p style={{ color: "#666", fontSize: ".9rem" }}>
        Embedding allowed from: {ALLOWED_ORIGINS.join(", ")}. Index status: <a href="/api/health">/api/health</a>.
      </p>
    </main>
  );
}
