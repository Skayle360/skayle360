/**
 * The single script tag the client pastes into Webflow:
 *
 *   <script src="https://chat.skayle360.com/widget.js" defer></script>
 *
 * Everything the visitor sees lives inside an iframe, including the launcher
 * bubble. Webflow ships a global stylesheet with broad element selectors, and
 * an in-page widget would inherit its button, input and box-sizing rules; an
 * iframe is its own document, so none of that reaches us. It also means this
 * loader injects no CSS into the host page beyond positioning the frame.
 */
(function () {
  const HOST = (document.currentScript as HTMLScriptElement | null)?.src.replace(/\/widget\.js.*$/, "") ?? "";
  const ID = "skayle360-chat-frame";
  if (document.getElementById(ID)) return;

  const COLLAPSED = { width: "76px", height: "76px" };
  const EXPANDED = { width: "400px", height: "620px" };

  const frame = document.createElement("iframe");
  frame.id = ID;
  frame.title = "SCALE UP assistant";
  frame.src = `${HOST}/widget?host=${encodeURIComponent(location.origin)}`;
  frame.setAttribute("allowtransparency", "true");
  frame.setAttribute("aria-live", "polite");

  Object.assign(frame.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    border: "0",
    zIndex: "2147483000",
    colorScheme: "normal",
    background: "transparent",
    maxWidth: "calc(100vw - 24px)",
    maxHeight: "calc(100vh - 24px)",
    transition: "width .22s ease, height .22s ease",
    ...COLLAPSED,
  } as Partial<CSSStyleDeclaration>);

  function setOpen(open: boolean) {
    const isPhone = window.matchMedia("(max-width: 480px)").matches;
    if (open && isPhone) {
      // On a phone, a 400px panel floating over the page is unusable. Take the
      // viewport; most owners will hit this on a phone.
      Object.assign(frame.style, { width: "100vw", height: "100dvh", bottom: "0", right: "0", maxWidth: "100vw", maxHeight: "100dvh" });
    } else if (open) {
      Object.assign(frame.style, { ...EXPANDED, bottom: "20px", right: "20px" });
    } else {
      Object.assign(frame.style, { ...COLLAPSED, bottom: "20px", right: "20px", maxWidth: "calc(100vw - 24px)", maxHeight: "calc(100vh - 24px)" });
    }
  }

  window.addEventListener("message", (event: MessageEvent) => {
    // Only obey our own frame: any page can postMessage to this window.
    if (event.source !== frame.contentWindow) return;
    const data = event.data as { source?: string; type?: string; open?: boolean } | null;
    if (!data || data.source !== "skayle360-chat") return;
    if (data.type === "resize") setOpen(Boolean(data.open));
  });

  const mount = () => document.body.appendChild(frame);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
