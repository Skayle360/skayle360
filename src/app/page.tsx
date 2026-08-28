import { ALLOWED_ORIGINS } from "@config/app";
import "@/app/home.css";

export const metadata = {
  title: "SCALE UP assistant — preview",
  robots: { index: false, follow: false },
};

/**
 * A preview of the assistant, not a public page.
 *
 * This host serves the API and the widget; the widget itself belongs on
 * skayle360.com. The page is deliberately plain and labelled as a preview so
 * nobody mistakes it for a second Skayle 360 homepage or bookmarks it in place
 * of the real site. `robots.txt` blocks indexing regardless.
 */
export default function Home() {
  return (
    <main className="home">
      <div className="inner">
        <p className="eyebrow">Preview · not a public page</p>
        <h1>SCALE UP assistant</h1>
        <p className="lede">
          The chat assistant for skayle360.com. It answers only from Skayle&nbsp;360&rsquo;s own
          material and cites where each answer came from.
        </p>

        <p className="cue">
          Open it with the button in the bottom-right corner. Try asking:
        </p>
        <ul className="prompts">
          <li>&ldquo;How much does the grant cover?&rdquo;</li>
          <li>&ldquo;We&rsquo;re a nonprofit in Rhode Island — do we qualify?&rdquo;</li>
          <li>&ldquo;When does the winter cohort start?&rdquo;</li>
        </ul>

        <section className="embed">
          <h2>Installing it</h2>
          <p>One line in Webflow &rsaquo; Site Settings &rsaquo; Custom Code &rsaquo; Footer:</p>
          <pre>{`<script src="https://chat.skayle360.com/widget.js" defer></script>`}</pre>
          <p className="meta">
            Embedding is permitted from {ALLOWED_ORIGINS.join(" and ")}.
            Index status: <a href="/api/health">/api/health</a>.
          </p>
        </section>
      </div>
      <script src="/widget.js" defer />
    </main>
  );
}
