"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import "@/app/admin/admin.css";

interface Upload {
  id: string; filename: string; size_bytes: number; status: string; error: string | null;
  words: number | null; chunk_count: number | null; created_at: string;
}
interface Doc {
  doc_id: string; title: string; source_type: string; words: number; chunks: number; embedded: number; origin: string;
}
interface Setting {
  key: string; label: string; help: string; value: string; isDefault: boolean; presets: Record<string, string> | null;
}
interface Totals { documents: number; chunks: number; embedded: number }
interface Excluded { doc_id: string; title: string | null; reason: string | null; excluded_at: string }

const STAGES = ["queued", "extracting", "chunking", "embedding", "live"] as const;
const IN_FLIGHT = STAGES.slice(0, 4) as readonly string[];

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const ICON = {
  docs: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 15h6",
  prompt: "M4 5h16M4 12h10M4 19h7",
  note: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  upload: "M12 16V4m0 0L7 9m5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
};

export default function Admin() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<"documents" | "knowledge" | "prompts">("documents");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [excluded, setExcluded] = useState<Excluded[]>([]);
  const [settings, setSettings] = useState<Setting[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState("");

  /** Any failure must resolve the loading state, or the page hangs with no reason shown. */
  const loadDocuments = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/uploads");
      if (res.status === 401) { setAuthed(false); setLoadError(""); return; }
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const data = await res.json();
      setUploads(data.uploads ?? []);
      setDocs(data.documents ?? []);
      setTotals(data.totals ?? null);
      setExcluded(data.excluded ?? []);
      setLoadError("");
      setAuthed(true);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not reach the server");
      setAuthed(false);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    const res = await fetch("/api/admin/settings").catch(() => null);
    if (res?.ok) setSettings((await res.json()).settings ?? []);
  }, []);

  useEffect(() => { void loadDocuments(); void loadSettings(); }, [loadDocuments, loadSettings]);

  // Poll only while something is mid-pipeline, so an idle page stays quiet.
  useEffect(() => {
    if (!uploads.some((u) => IN_FLIGHT.includes(u.status))) return;
    const t = setInterval(() => void loadDocuments(), 2500);
    return () => clearInterval(t);
  }, [uploads, loadDocuments]);

  if (authed === null) return <div className="login"><p>Loading…</p></div>;
  if (authed === false) return <Login error={loadError} onIn={() => { void loadDocuments(); void loadSettings(); }} />;

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <b>SCALE UP</b>
          <span>Admin</span>
        </div>
        <nav>
          <button className={tab === "documents" ? "on" : ""} onClick={() => setTab("documents")}>
            <Icon d={ICON.docs} /> Documents
          </button>
          <button className={tab === "knowledge" ? "on" : ""} onClick={() => setTab("knowledge")}>
            <Icon d={ICON.note} /> Chris&rsquo;s notes
          </button>
          <button className={tab === "prompts" ? "on" : ""} onClick={() => setTab("prompts")}>
            <Icon d={ICON.prompt} /> Prompts
          </button>
        </nav>
        <footer>
          {totals && (
            <dl className="health">
              <dt>Knowledge base</dt>
              <dd><span>Documents</span><span>{totals.documents}</span></dd>
              <dd><span>Chunks</span><span>{totals.chunks.toLocaleString()}</span></dd>
              <dd>
                <span>Embedded</span>
                <span>{totals.embedded === totals.chunks ? "all" : `${totals.embedded}/${totals.chunks}`}</span>
              </dd>
            </dl>
          )}
          <button className="ghost small" onClick={async () => {
            await fetch("/api/admin/login", { method: "DELETE" });
            setAuthed(false);
          }}>Sign out</button>
        </footer>
      </aside>

      <main className="main">
        {notice && (
          <div className="note bad" style={{ marginBottom: 16 }}>
            <p>{notice} <button className="link" onClick={() => setNotice("")}>dismiss</button></p>
          </div>
        )}
        {tab === "documents" && (
          <Documents uploads={uploads} docs={docs} excluded={excluded} busy={busy} setBusy={setBusy}
                     setNotice={setNotice} reload={loadDocuments} />
        )}
        {tab === "knowledge" && <Knowledge reload={loadDocuments} />}
        {tab === "prompts" && <Prompts settings={settings} reload={loadSettings} />}
      </main>
    </div>
  );
}

function Login({ error, onIn }: { error: string; onIn: () => void }) {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const res = await fetch("/api/admin/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) { setPassword(""); onIn(); }
    else setErr((await res?.json().catch(() => ({})))?.error ?? "Could not reach the server");
  }

  return (
    <div className="login">
      <div className="card">
        <h1>SCALE UP admin</h1>
        <p className="sub">Knowledge base and assistant settings.</p>
        {error && (
          <div className="note bad" style={{ marginBottom: 14 }}>
            <p>{error}. Check the server is running, then reload.</p>
          </div>
        )}
        <form onSubmit={submit}>
          {/* Password managers and screen readers expect a username beside a
              password. There is only one account, so it is fixed and hidden. */}
          <input type="text" name="username" value="admin" readOnly hidden autoComplete="username" />
          <label htmlFor="pw">Password</label>
          <input id="pw" type="password" value={password} autoFocus autoComplete="current-password"
                 onChange={(e) => setPassword(e.target.value)} />
          {err && <div className="note bad"><p>{err}</p></div>}
          <button type="submit" disabled={busy || !password}>{busy ? "Checking…" : "Sign in"}</button>
        </form>
      </div>
    </div>
  );
}

function Documents({ uploads, docs, excluded, busy, setBusy, setNotice, reload }: {
  uploads: Upload[]; docs: Doc[]; excluded: Excluded[]; busy: string;
  setBusy: (s: string) => void; setNotice: (s: string) => void; reload: () => Promise<void>;
}) {
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  /** Removing an indexed source also records it, so a re-ingest cannot restore it. */
  async function removeDoc(d: Doc) {
    if (!confirm(
      `Remove "${d.title}" from the knowledge base?\n\n` +
      `The assistant stops answering from it immediately, and it will stay out ` +
      `even after a full re-index. You can put it back from the list below.`,
    )) return;
    setBusy(`Removing ${d.title}…`);
    const res = await fetch("/api/admin/documents", {
      method: "DELETE", headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId: d.doc_id }),
    }).catch(() => null);
    if (!res?.ok) setNotice((await res?.json().catch(() => ({})))?.error ?? "Could not remove");
    setBusy("");
    await reload();
  }

  async function restoreDoc(e: Excluded) {
    setBusy(`Restoring ${e.title ?? e.doc_id}…`);
    await fetch("/api/admin/documents", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId: e.doc_id }),
    });
    setBusy("");
    setNotice(`"${e.title ?? e.doc_id}" will return on the next full re-index (npm run ingest).`);
    await reload();
  }

  async function send(files: FileList | null) {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      setBusy(`Uploading ${file.name}…`);
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/admin/uploads", { method: "POST", body }).catch(() => null);
      if (!res?.ok) setNotice((await res?.json().catch(() => ({})))?.error ?? "Upload failed");
      await reload();
    }
    setBusy("");
    if (fileInput.current) fileInput.current.value = "";
  }

  async function remove(u: Upload) {
    if (!confirm(`Remove "${u.filename}"? The assistant stops answering from it immediately.`)) return;
    setBusy(`Removing ${u.filename}…`);
    await fetch("/api/admin/uploads", {
      method: "DELETE", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: u.id }),
    });
    setBusy("");
    await reload();
  }

  return (
    <>
      <div className="page-head">
        <h1>Documents</h1>
        <p>What the assistant is allowed to answer from.</p>
      </div>

      <section className="panel">
        <div className="panel-body">
          <div className={`drop${dragging ? " over" : ""}`}
               onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
               onDragLeave={() => setDragging(false)}
               onDrop={(e) => { e.preventDefault(); setDragging(false); void send(e.dataTransfer.files); }}>
            <Icon d={ICON.upload} />
            <p><strong>Drop a file here</strong> or <button className="link" onClick={() => fileInput.current?.click()}>browse</button></p>
            <p>PDF, Word, PowerPoint or text · up to 25MB</p>
            <input ref={fileInput} type="file" hidden multiple accept=".pdf,.docx,.pptx,.txt,.md"
                   onChange={(e) => void send(e.target.files)} />
          </div>
          {busy && <div className="note info"><p>{busy}</p></div>}
        </div>
      </section>

      {uploads.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2>Recent uploads</h2>
            <p>Each file is only answerable once it reaches <em>live</em>.</p>
          </div>
          <div className="panel-body">
            {uploads.map((u) => (
              <article key={u.id} className="upload">
                <div className="upload-head">
                  <b>{u.filename}</b>
                  <span>{(u.size_bytes / 1e6).toFixed(1)} MB</span>
                </div>
                {u.status === "failed"
                  ? <div className="note bad" style={{ marginTop: 10 }}><p>{u.error ?? "Failed"}</p></div>
                  : <Pipeline status={u.status} />}
                <div className="upload-foot">
                  <p>
                    {u.status === "live"
                      ? `${u.words?.toLocaleString()} words · ${u.chunk_count} chunks`
                      : u.status === "failed" ? "Not indexed" : "Processing…"}
                  </p>
                  <button className="danger small" onClick={() => void remove(u)}>Remove</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {excluded.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2>Removed</h2>
            <p>Kept out of the knowledge base, including after a full re-index.</p>
          </div>
          <div className="panel-body">
            {excluded.map((e) => (
              <div className="upload" key={e.doc_id}>
                <div className="upload-head">
                  <b>{e.title ?? e.doc_id}</b>
                  <span>{when(e.excluded_at)}</span>
                </div>
                <div className="upload-foot">
                  <p>Not answering from this.</p>
                  <button className="ghost small" onClick={() => void restoreDoc(e)}>Put back</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-head" style={{ paddingBottom: 14 }}>
          <h2>Indexed knowledge</h2>
          <p>{docs.length} sources the assistant can cite.</p>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr><th>Source</th><th>Type</th><th className="num">Words</th><th className="num">Chunks</th><th className="num">Embedded</th><th /></tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.doc_id}>
                  <td>{d.title}</td>
                  <td>
                    <span className={`tag${d.source_type === "correction" ? " accent" : ""}`}>
                      {d.source_type.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="num">{d.words.toLocaleString()}</td>
                  <td className="num">{d.chunks}</td>
                  <td className="num">{d.embedded === d.chunks ? "all" : `${d.embedded}/${d.chunks}`}</td>
                  <td className="num">
                    <button className="danger small" onClick={() => void removeDoc(d)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Pipeline({ status }: { status: string }) {
  const at = STAGES.indexOf(status as (typeof STAGES)[number]);
  return (
    <ol className="pipeline">
      {STAGES.map((s, i) => (
        <li key={s} className={i < at ? "done" : i === at ? "now" : ""}>
          <span className="dot">{s}</span>
          {i < STAGES.length - 1 && <span className="bar" />}
        </li>
      ))}
    </ol>
  );
}

function Prompts({ settings, reload }: { settings: Setting[]; reload: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState("");

  const save = async (key: string, value: string) => {
    await fetch("/api/admin/settings", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    setDrafts((d) => { const n = { ...d }; delete n[key]; return n; });
    setSaved(key);
    setTimeout(() => setSaved(""), 2500);
    reload();
  };

  const reset = async (key: string) => {
    await fetch("/api/admin/settings", {
      method: "DELETE", headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
    setDrafts((d) => { const n = { ...d }; delete n[key]; return n; });
    reload();
  };

  return (
    <>
      <div className="page-head">
        <h1>Prompts</h1>
        <p>How the assistant sounds and how it handles a conversation.</p>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Fixed rules</h2>
          <p>These are what the assistant is sold on, so they live in code and cannot be changed here.</p>
        </div>
        <div className="panel-body">
          <ul className="locked-list">
            {[
              "Answers only from the knowledge base",
              "Cites a source for every factual claim",
              "Never promises grant approval — that is the state's decision",
              "Corrections override the website and the training documents",
            ].map((rule) => (
              <li key={rule}><Icon d={ICON.lock} /> {rule}</li>
            ))}
          </ul>
        </div>
      </section>

      {settings.map((s) => {
        const value = drafts[s.key] ?? s.value;
        const dirty = value !== s.value;
        return (
          <section className="panel" key={s.key}>
            <div className="panel-head">
              <h2>{s.label} {!s.isDefault && <span className="tag accent">edited</span>}</h2>
              <p>{s.help}</p>
            </div>
            <div className="panel-body">
              {s.presets && (
                <div className="presets">
                  {Object.keys(s.presets).map((name) => (
                    <button key={name} className="ghost small"
                            onClick={() => setDrafts((d) => ({ ...d, [s.key]: s.presets![name]! }))}>
                      {name}
                    </button>
                  ))}
                </div>
              )}
              <textarea rows={9} value={value}
                        onChange={(e) => setDrafts((d) => ({ ...d, [s.key]: e.target.value }))} />
              <div className="field-foot">
                <button onClick={() => void save(s.key, value)} disabled={!dirty}>Save</button>
                {!s.isDefault && <button className="ghost small" onClick={() => void reset(s.key)}>Reset to default</button>}
                <span className="spacer" />
                {saved === s.key
                  ? <span className="saved">Saved · live within 30s</span>
                  : <span className="tag">{value.length} chars</span>}
              </div>
              <History settingKey={s.key} current={s.value} onRestore={reload} />
            </div>
          </section>
        );
      })}
    </>
  );
}

/**
 * The client's own knowledge entry.
 *
 * Plain sentences, saved and live in seconds. This is the fifth requirement —
 * "I can update the knowledge myself" — without a repository or a command.
 */
function Knowledge({ reload }: { reload: () => Promise<void> }) {
  const [text, setText] = useState<string | null>(null);
  const [original, setOriginal] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/admin/knowledge").catch(() => null);
      if (!res?.ok) { setError("Could not load"); setText(""); return; }
      const t = (await res.json()).text ?? "";
      setText(t);
      setOriginal(t);
    })();
  }, []);

  async function save() {
    if (text === null) return;
    setSaving(true);
    setError("");
    setResult("");
    const res = await fetch("/api/admin/knowledge", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) { setError((await res?.json().catch(() => ({})))?.error ?? "Save failed"); return; }
    const r = await res.json();
    setOriginal(text);
    setResult(`Saved — answering from it now (${r.chunks} section${r.chunks === 1 ? "" : "s"}).`);
    await reload();
  }

  return (
    <>
      <div className="page-head">
        <h1>Chris&rsquo;s notes</h1>
        <p>Facts that change faster than the documents do. Anything here wins.</p>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>How this works</h2>
          <p>
            Write plain sentences. This overrides the website and the training documents wherever
            they disagree — it is how the wrong cohort dates were corrected. Use it for dates,
            prices and what is currently open, not for rewriting course content.
          </p>
        </div>
        <div className="panel-body">
          <textarea rows={18} value={text ?? ""} disabled={text === null}
                    onChange={(e) => setText(e.target.value)} />
          {error && <div className="note bad"><p>{error}</p></div>}
          <div className="field-foot">
            <button onClick={() => void save()} disabled={saving || text === null || text === original}>
              {saving ? "Saving…" : "Save"}
            </button>
            <span className="spacer" />
            {result ? <span className="saved">{result}</span> : <span className="tag">overrides everything else</span>}
          </div>
          <History settingKey="client_knowledge" current={original}
                   onRestore={() => { setText(null); void (async () => {
                     const res = await fetch("/api/admin/knowledge");
                     const t = res.ok ? (await res.json()).text ?? "" : "";
                     setText(t); setOriginal(t); setResult("Restored — answering from it now.");
                   })(); }} />
        </div>
      </section>
    </>
  );
}

interface Version {
  id: string; key: string; value: string; created_at: string;
  created_by: string | null; restored_from: string | null;
}

/** Renders the edit trail for one editable block, with restore. */
function History({ settingKey, current, onRestore }: {
  settingKey: string; current: string; onRestore: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [previewing, setPreviewing] = useState<Version | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/versions?key=${encodeURIComponent(settingKey)}`).catch(() => null);
    setVersions(res?.ok ? (await res.json()).versions ?? [] : []);
  }, [settingKey]);

  useEffect(() => { if (open && versions === null) void load(); }, [open, versions, load]);

  async function restore(v: Version) {
    if (!confirm(`Restore the version from ${when(v.created_at)}? The current text is kept in the history.`)) return;
    setBusy(true);
    await fetch("/api/admin/versions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: v.id }),
    });
    setBusy(false);
    setPreviewing(null);
    setVersions(null);
    onRestore();
  }

  if (!open) {
    return (
      <button className="link small" onClick={() => setOpen(true)}>
        View edit history
      </button>
    );
  }

  return (
    <div className="history">
      <div className="row">
        <strong>Edit history</strong>
        <button className="link small" onClick={() => { setOpen(false); setPreviewing(null); }}>hide</button>
      </div>
      {versions === null && <p className="muted small">Loading…</p>}
      {versions?.length === 0 && <p className="muted small">No edits yet — this is the original.</p>}
      {versions && versions.length > 0 && (
        <ol className="versions">
          {versions.map((v) => (
            <li key={v.id}>
              <div className="row">
                <span className="vtime">{when(v.created_at)}</span>
                {v.restored_from && <span className="tag">was a restore</span>}
                <span className="spacer" />
                <button className="ghost small" onClick={() => setPreviewing(previewing?.id === v.id ? null : v)}>
                  {previewing?.id === v.id ? "hide" : "view"}
                </button>
                <button className="ghost small" disabled={busy || v.value === current}
                        onClick={() => void restore(v)}>
                  {v.value === current ? "current" : "restore"}
                </button>
              </div>
              {previewing?.id === v.id && <pre className="vpreview">{v.value}</pre>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function when(iso: string): string {
  const d = new Date(iso.replace(" ", "T"));
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} hr ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
