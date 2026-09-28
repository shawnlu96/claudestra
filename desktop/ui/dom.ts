// Tiny DOM + IPC helpers. All text goes through textContent — doctor output is never parsed as HTML.
import { icon, type IconName } from "./icons";

type Child = Node | string | null | undefined | false;

export function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}

export function button(label: string, ico: IconName, onClick: (b: HTMLButtonElement) => void, cls = ""): HTMLButtonElement {
  const b = h("button", { type: "button", class: `btn ${cls}` }, icon(ico), h("span", {}, label)) as HTMLButtonElement;
  b.addEventListener("click", () => onClick(b));
  return b;
}

export function setLabel(b: HTMLButtonElement, label: string): void {
  const span = b.querySelector("span");
  if (span) span.textContent = label;
}

export function statusIcon(status: string): SVGSVGElement {
  const s = status === "ok" || status === "warn" || status === "fail" ? status : "unknown";
  return icon(s, `st-${s}`);
}

let zh = true;
export function setZh(v: boolean): void { zh = v; }
export function t(zhText: string, en: string): string { return zh ? zhText : en; }

interface TauriGlobal { core: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> } }

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri) return Promise.reject(new Error("not running inside the Claudestra app"));
  return tauri.core.invoke<T>(cmd, args);
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
