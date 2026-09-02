/** @jsxImportSource preact */
import { render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { THEME } from "@config/theme";

interface Source {
  label: string;
  quote: string;
  origin: string;
}

interface Material { name: string; url: string; mediaType: string; sizeBytes: number }

interface Turn {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  materials?: Material[];
  bookingUrl?: string;
  escalated?: boolean;
  pending?: boolean;
}

/**
 * The widget page and the API are served from the same origin
 * (chat.skayle360.com), so a relative path is correct in production. Overridden
 * at build time via esbuild `define` for local development only — deliberately
 * not read from the query string, which would let a crafted link point the
 * widget at someone else's endpoint.
 */
declare const __API_URL__: string;
const API = __API_URL__;

const GREETING =
  "Hi — I can answer questions about SCALE UP, the Massachusetts grant that funds it, and the roundtables. What would you like to know?";

function uuid(): string {
  return crypto.randomUUID();
}

/** Tell the parent page to grow or shrink the iframe. */
function postSize(open: boolean): void {
  parent.postMessage({ source: "skayle360-chat", type: "resize", open }, "*");
}

/** A 40 KB file rendered as "0.0 MB" reads as an upload that failed. */
function fileSize(bytes: number): string {
  return bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

function Launcher({ onOpen }: { onOpen: () => void }) {
  return (
    <button class="launcher" onClick={onOpen} aria-label="Open the SCALE UP assistant">
      {/* Skayle 360's own mark: the 0 of "360" drawn as a full-rotation arrow.
          Redrawn here rather than using the site's logo file, which is a 26 KB
          Lottie export of the whole wordmark and illegible at 26px. */}
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M19.24 10.06A7.5 7.5 0 1 1 14.57 4.95"
          stroke="currentColor"
          stroke-width="2.6"
          stroke-linecap="round"
        />
        <path d="M14.2 1.1 L19.6 4.7 L13.9 7.9 Z" fill="currentColor" />
      </svg>
    </button>
  );
}

function Sources({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState(false);
  if (!sources.length) return null;
  return (
    <div class="sources">
      <button class="sources-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? "Hide" : "Show"} {sources.length === 1 ? "source" : `${sources.length} sources`}
      </button>
      {open && (
        <ul>
          {sources.map((s, i) => (
            <li key={i}>
              <span class="source-label">Source: {s.label}</span>
              {s.quote && <blockquote>{s.quote.slice(0, 240)}</blockquote>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function App() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([{ role: "assistant", content: GREETING }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const conversationId = useRef(uuid());
  const scroller = useRef<HTMLDivElement | null>(null);
  const hostUrl = useRef<string | null>(null);

  useEffect(() => {
    const host = new URLSearchParams(location.search).get("host");
    hostUrl.current = host && /^https?:\/\//.test(host) ? host : null;
  }, []);

  useEffect(() => postSize(open), [open]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);

    const history = turns
      .filter((t) => !(t.role === "assistant" && t.content === GREETING))
      .map((t) => ({ role: t.role, content: t.content }));

    setTurns((t) => [...t, { role: "user", content: message }, { role: "assistant", content: "", pending: true }]);

    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: conversationId.current, message, history, sourceUrl: hostUrl.current }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const patch = (fn: (turn: Turn) => Turn) =>
        setTurns((all) => all.map((t, i) => (i === all.length - 1 ? fn(t) : t)));

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line; a chunk can split one.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const event = JSON.parse(line.slice(6));
          switch (event.type) {
            case "text":
              patch((t) => ({ ...t, content: t.content + event.text, pending: false }));
              break;
            case "sources":
              patch((t) => ({ ...t, sources: [...(t.sources ?? []), ...event.sources] }));
              break;
            case "booking":
              patch((t) => ({ ...t, bookingUrl: event.url }));
              break;
            case "materials":
              patch((t) => ({ ...t, materials: event.files }));
              break;
            case "escalated":
              patch((t) => ({ ...t, escalated: true }));
              break;
            case "error":
              patch((t) => ({ ...t, content: event.message, pending: false }));
              break;
          }
        }
      }
      patch((t) => ({ ...t, pending: false }));
    } catch {
      setTurns((all) =>
        all.map((t, i) =>
          i === all.length - 1
            ? { ...t, pending: false, content: "I couldn't reach the server just then. Please try again." }
            : t,
        ),
      );
    } finally {
      setBusy(false);
    }
  }, [input, busy, turns]);

  if (!open) return <Launcher onOpen={() => setOpen(true)} />;

  return (
    <div class="panel" role="dialog" aria-label="SCALE UP assistant">
      <header>
        <div>
          <strong>SCALE UP assistant</strong>
          <span>Skayle 360 · Grant · Program</span>
        </div>
        <button class="close" onClick={() => setOpen(false)} aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>
      </header>

      <div class="log" ref={scroller}>
        {turns.length > 0 && (
          <p class="daymark">
            <span>Today</span>
          </p>
        )}
        {turns.map((turn, i) => (
          <div key={i} class={`turn ${turn.role}`}>
            {turn.role === "assistant" && (
              <span class="avatar" aria-hidden="true">
                S
              </span>
            )}
            <div class="turn-body">
            {turn.pending && !turn.content ? (
              <div class="dots" aria-label="Thinking">
                <span /><span /><span />
              </div>
            ) : (
              <div class="bubble">{turn.content}</div>
            )}
            {turn.materials?.map((m) => (
              <a key={m.url} class="file" href={m.url} target="_blank" rel="noopener noreferrer">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6"
                        stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <span class="file-name">{m.name}</span>
                <span class="file-size">{fileSize(m.sizeBytes)}</span>
              </a>
            ))}
            {turn.bookingUrl && (
              <a class="book" href={turn.bookingUrl} target="_blank" rel="noopener noreferrer">
                Book a 15-minute call →
              </a>
            )}
            {turn.escalated && <p class="note">Sent to Chris — he'll follow up by email.</p>}
            {turn.sources && <Sources sources={turn.sources} />}
            </div>
          </div>
        ))}
      </div>

      <form
        class="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          value={input}
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
          placeholder="Ask about the program or the grant..."
          aria-label="Your message"
          maxLength={2000}
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()} aria-label="Send">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 12h15M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </form>

      <p class="disclaimer">Answers come from Skayle 360's own material.</p>
    </div>
  );
}

const root = document.getElementById("root")!;
root.style.setProperty("--accent", THEME.accent);
render(<App />, root);
