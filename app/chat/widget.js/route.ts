const loader = String.raw`(() => {
  "use strict";
  const script = document.currentScript;
  if (!(script instanceof HTMLScriptElement)) return;
  const widgetId = script.dataset.widgetId || "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(widgetId)) return;

  const appOrigin = new URL(script.src, document.baseURI).origin;
  const title = script.dataset.title || "Atendimento online";
  const requestedColor = script.dataset.color || "#0f766e";
  const color = /^#[0-9a-f]{6}$/i.test(requestedColor) ? requestedColor : "#0f766e";
  const frame = document.createElement("iframe");
  frame.src = appOrigin + "/chat/embed/" + encodeURIComponent(widgetId);
  frame.title = title;
  frame.referrerPolicy = "no-referrer";
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  frame.allow = "clipboard-write";
  Object.assign(frame.style, {
    position: "fixed", right: "20px", bottom: "84px", width: "min(380px, calc(100vw - 32px))",
    height: "min(620px, calc(100vh - 112px))", border: "0", borderRadius: "16px",
    boxShadow: "0 12px 48px rgba(0,0,0,.22)", zIndex: "2147483000", display: "none", background: "white"
  });
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = title;
  button.setAttribute("aria-label", title);
  button.setAttribute("aria-expanded", "false");
  Object.assign(button.style, {
    position: "fixed", right: "20px", bottom: "20px", maxWidth: "calc(100vw - 40px)",
    border: "0", borderRadius: "999px", padding: "14px 20px", color: "white", background: color,
    font: "600 14px system-ui,sans-serif", boxShadow: "0 4px 18px rgba(0,0,0,.22)",
    cursor: "pointer", zIndex: "2147483001"
  });
  button.addEventListener("click", () => {
    const open = frame.style.display === "none";
    frame.style.display = open ? "block" : "none";
    button.setAttribute("aria-expanded", String(open));
  });
  document.body.append(frame, button);
})();`;

export function GET(): Response {
  return new Response(loader, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
