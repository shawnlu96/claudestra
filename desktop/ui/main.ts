// 菜单栏小程序的窗口：状态 / 体检 / 安装三页。Rust 侧只转发 desktop-cli 的 JSON，判断都在 TS（src/desktop-cli.ts）。
import { renderDoctor } from "./doctor";
import { button, errText, h, invoke, setLabel, setZh, statusIcon, t } from "./dom";
import { renderSetup } from "./setup";
import type { AppInfo, Install, RestartResult, Status } from "./types";

type Tab = "status" | "doctor" | "setup";
const POLL_MS = 5000;

let info: AppInfo | null = null;
let current: Tab = "status";
let pollTimer: number | undefined;
const pages: Record<Tab, HTMLElement> = { status: h("div"), doctor: h("div"), setup: h("div") };
const pill = h("span", { class: "pill" });

const notice = h("div", { class: "notice", role: "alert", hidden: "" });

/** 菜单里的操作失败时，Rust 打开窗口并把原因送到这里；窗口里的按钮失败也走这里 */
function showNotice(msg: string): void {
  notice.replaceChildren(h("span", {}, msg), button(t("知道了", "Dismiss"), "x", () => { notice.hidden = true; }, "ghost"));
  notice.hidden = false;
}

/** 按钮触发的调用：失败一律进提示条，不能静默 */
function act(cmd: string): void {
  invoke(cmd).catch((e) => showNotice(errText(e)));
}

function setPill(overall: string | null, restarting = false): void {
  const text: Record<string, string> = {
    ok: t("运行正常", "Running"), warn: t("有警告", "Warnings"), fail: t("有服务没在运行", "Service down"),
  };
  // 刚重启完先灰着：kickstart 后马上读到的是新 pid，看着健康，其实还没起来
  const key = restarting ? "unknown" : overall ?? "unknown";
  const label = restarting ? t("正在重启…", "Restarting…") : overall ? text[overall] ?? overall : t("未安装", "Not installed");
  pill.className = `pill st-${key}`;
  pill.replaceChildren(statusIcon(key), h("span", {}, label));
}

function restartButton(onDone: () => void): HTMLButtonElement {
  let armed: number | undefined;
  const idle = t("重启服务", "Restart services");
  return button(idle, "refresh", async (b) => {
    // 两步确认：重启 bridge 会打断正在推送的消息流，误点一下不该就发生
    if (armed === undefined) {
      setLabel(b, t("确认重启？会打断正在推送的消息", "Confirm? Interrupts messages being streamed"));
      b.classList.add("danger");
      armed = window.setTimeout(() => { armed = undefined; setLabel(b, idle); b.classList.remove("danger"); }, 4000);
      return;
    }
    window.clearTimeout(armed);
    armed = undefined;
    b.classList.remove("danger");
    b.disabled = true;
    b.classList.add("busy");
    setLabel(b, t("重启中…", "Restarting…"));
    try {
      await invoke<RestartResult>("restart");
      setLabel(b, t("已重启", "Restarted"));
    } catch (e) {
      setLabel(b, t("重启失败", "Restart failed"));
      showNotice(`${t("重启失败", "Restart failed")}：${errText(e)}`);
    } finally {
      b.disabled = false;
      b.classList.remove("busy");
      window.setTimeout(() => setLabel(b, idle), 3000);
      onDone();
    }
  });
}

function notInstalled(inst: Install): HTMLElement {
  const why = inst.has_checkout
    ? t(`在 ${inst.repo} 找到了 Claudestra，但还没装好后台服务，或者版本比这个小程序旧。`,
      `Found Claudestra at ${inst.repo}, but its services aren't set up yet, or it's older than this app.`)
    : t("这台电脑上还没有 Claudestra。", "Claudestra isn't installed on this Mac yet.");
  return h("section", { class: "card empty-state" }, h("h3", {}, t("还没装好", "Not set up yet")), h("p", {}, why),
    button(t("去安装", "Go to setup"), "download", () => show("setup"), "primary"));
}

function daemonList(s: Status): HTMLElement {
  return h("ul", { class: "checks daemons" }, ...s.daemons.map((d) => h("li", { class: `check st-row-${d.status}` },
    statusIcon(d.status),
    h("div", { class: "check-body" }, h("div", { class: "check-head" },
      h("span", { class: "check-name" }, d.name),
      h("span", { class: "check-detail" }, d.detail))))));
}

/** 页面骨架只建一次，轮询只换服务列表和事实行——按钮（含两步确认的中间态）不能被刷新冲掉 */
let statusView: { list: HTMLElement; facts: HTMLElement } | null = null;

function buildStatusView(): { list: HTMLElement; facts: HTMLElement } {
  const list = h("div");
  const facts = h("dl", { class: "facts" });
  pages.status.replaceChildren(
    h("section", { class: "card" }, h("h3", {}, t("后台服务", "Services")), list),
    h("div", { class: "actions" },
      button(t("打开 Claudestra 网页", "Open Claudestra"), "globe", () => act("open_web"), "primary"),
      restartButton(() => void refreshStatus()),
      button(t("打开日志目录", "Open log folder"), "folder", () => act("open_logs")),
      button(t("体检", "Health check"), "stethoscope", () => show("doctor"))),
    facts);
  return { list, facts };
}

async function refreshStatus(): Promise<void> {
  if (!info) return;
  try {
    const s = await invoke<Status>("status");
    setPill(s.overall, s.restarting);
    statusView ??= buildStatusView();
    statusView.list.replaceChildren(daemonList(s));
    statusView.facts.replaceChildren(
      h("dt", {}, t("网页", "Web")), h("dd", {}, s.webUrl),
      h("dt", {}, t("安装位置", "Installed at")), h("dd", {}, s.repoRoot),
      h("dt", {}, t("日志", "Logs")), h("dd", {}, s.logDir));
  } catch (e) {
    setPill(null);
    statusView = null;
    info = await invoke<AppInfo>("app_info");
    pages.status.replaceChildren(info.install.cli_available ? h("p", { class: "error" }, errText(e)) : notInstalled(info.install));
  }
}

function show(tab: Tab): void {
  current = tab;
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  for (const [k, el] of Object.entries(pages)) el.hidden = k !== tab;
  if (!info) return;
  if (tab === "status") void refreshStatus();
  if (tab === "doctor" && !pages.doctor.childElementCount) renderDoctor(pages.doctor);
  if (tab === "setup") renderSetup(pages.setup, info.install, () => void refreshStatus());
}

async function boot(): Promise<void> {
  try {
    info = await invoke<AppInfo>("app_info");
  } catch (e) {
    document.body.replaceChildren(h("p", { class: "error" }, errText(e)));
    return;
  }
  setZh(info.zh);
  document.documentElement.lang = info.zh ? "zh-CN" : "en";
  const tabs: [Tab, string][] = [["status", t("状态", "Status")], ["doctor", t("体检", "Health check")], ["setup", t("安装", "Setup")]];
  const nav = h("nav", { class: "tabs", role: "tablist" }, ...tabs.map(([id, label]) => {
    const b = h("button", { type: "button", class: "tab", role: "tab", "data-tab": id }, label);
    b.addEventListener("click", () => show(id));
    return b;
  }));
  document.body.replaceChildren(
    h("header", { class: "top" }, h("h1", {}, "Claudestra"), pill, h("span", { class: "version" }, `v${info.version}`)),
    nav,
    notice,
    h("main", {}, ...Object.values(pages)));
  Object.assign(window, { __claudestraNav: show, __claudestraNotice: showNotice });
  show(current);
  // 窗口开着才刷新（安装页也刷，装完顶上的状态会自己变绿）；菜单栏自己的轮询在 Rust 侧
  pollTimer = window.setInterval(() => { if (!document.hidden && current !== "doctor") void refreshStatus(); }, POLL_MS);
}

window.addEventListener("beforeunload", () => window.clearInterval(pollTimer));
void boot();
