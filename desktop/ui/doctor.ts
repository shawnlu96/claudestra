// 体检页：按需跑 doctor（只读，十几秒），按分区列出，问题项带「怎么修」。
import { button, errText, h, invoke, setLabel, statusIcon, t } from "./dom";
import type { Check, ChecksResult } from "./types";

export function checkItem(c: Check): HTMLElement {
  return h("li", { class: `check st-row-${c.status}` },
    statusIcon(c.status),
    h("div", { class: "check-body" },
      h("div", { class: "check-head" }, h("span", { class: "check-name" }, c.name), h("span", { class: "check-detail" }, c.detail)),
      c.fix ? h("div", { class: "check-fix" }, c.fix) : null));
}

export function checkRows(checks: Check[], onlyProblems: boolean): HTMLElement {
  const groups = new Map<string, Check[]>();
  for (const c of checks) {
    if (onlyProblems && c.status === "ok") continue;
    groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
  }
  if (!groups.size) return h("p", { class: "muted empty" }, t("没有问题。", "No problems found."));
  const wrap = h("div", { class: "groups" });
  for (const [group, list] of groups) {
    wrap.append(h("section", { class: "group" }, h("h3", {}, group), h("ul", { class: "checks" }, ...list.map(checkItem))));
  }
  return wrap;
}

function summary(checks: Check[]): HTMLElement {
  const n = (s: string) => checks.filter((c) => c.status === s).length;
  return h("div", { class: "counts" },
    h("span", { class: "count st-ok" }, statusIcon("ok"), `${n("ok")} ${t("正常", "ok")}`),
    h("span", { class: "count st-warn" }, statusIcon("warn"), `${n("warn")} ${t("警告", "warnings")}`),
    h("span", { class: "count st-fail" }, statusIcon("fail"), `${n("fail")} ${t("失败", "failures")}`));
}

export function renderDoctor(root: HTMLElement): void {
  let last: Check[] | null = null;
  let onlyProblems = true;
  const out = h("div", { class: "doctor-out" },
    h("p", { class: "muted" }, t("体检只读，不改任何东西，大约 15 秒。", "The check is read-only and takes about 15 seconds.")));
  const toggle = h("label", { class: "toggle" }, h("input", { type: "checkbox", checked: "" }), t("只看问题", "Problems only"));
  const input = toggle.querySelector("input") as HTMLInputElement;
  const draw = () => { if (last) out.replaceChildren(summary(last), checkRows(last, onlyProblems)); };
  input.addEventListener("change", () => { onlyProblems = input.checked; draw(); });

  const run = button(t("运行体检", "Run health check"), "stethoscope", async (b) => {
    b.disabled = true;
    b.classList.add("busy");
    setLabel(b, t("体检中…", "Checking…"));
    try {
      last = (await invoke<ChecksResult>("check", { kind: "doctor" })).checks;
      draw();
    } catch (e) {
      out.replaceChildren(h("p", { class: "error" }, errText(e)));
    } finally {
      b.disabled = false;
      b.classList.remove("busy");
      setLabel(b, t("重新体检", "Run again"));
    }
  }, "primary");
  root.replaceChildren(h("div", { class: "toolbar" }, run, toggle), out);
}
