// 安装页：图形化检测依赖，安装本身交给终端里的 setup（它要交互，逻辑不在这里重写）。
import { checkItem } from "./doctor";
import { button, errText, h, invoke, statusIcon, t } from "./dom";
import type { ChecksResult, Install, Tool } from "./types";

const HINTS: Record<string, [string, string]> = {
  git: ["安装向导会用 Homebrew 装上", "the installer adds it via Homebrew"],
  tmux: ["所有 agent 都跑在 tmux 里", "every agent runs inside tmux"],
  node: ["构建网页用（≥ 20）", "used to build the web app (≥ 20)"],
  bun: ["bridge / launcher / cron 都跑在 bun 上", "bridge, launcher and cron run on bun"],
  claude: ["Claude Code，装好后要先在终端里登录", "Claude Code — sign in once in a terminal"],
};

function toolRow(tool: Tool): HTMLElement {
  const hint = HINTS[tool.name];
  return h("li", { class: `check st-row-${tool.found ? "ok" : "fail"}` },
    statusIcon(tool.found ? "ok" : "fail"),
    h("div", { class: "check-body" },
      h("div", { class: "check-head" },
        h("span", { class: "check-name" }, tool.name),
        h("span", { class: "check-detail" }, tool.found ? tool.version ?? "" : t("没找到", "not found"))),
      hint ? h("div", { class: "check-note" }, t(hint[0], hint[1])) : null));
}

async function loadDeps(box: HTMLElement, inst: Install): Promise<void> {
  box.replaceChildren(h("p", { class: "muted" }, t("正在检测…", "Checking…")));
  try {
    const { tools } = await invoke<{ tools: Tool[] }>("probe_tools");
    const list = h("ul", { class: "checks" }, ...tools.map(toolRow));
    // 仓库在时再补几行：claude 版本够不够、有没有登录（desktop-cli deps = doctor 的「运行时」分区）；
    // 取不到就只显示上面的版本行，登录状态由终端里的安装向导再查一遍
    if (inst.cli_available) {
      const deps = await invoke<ChecksResult>("check", { kind: "deps" }).catch(() => null);
      const account = deps?.checks.filter((c) => c.name.startsWith("claude ") || c.name === "bun PTY") ?? [];
      list.append(...account.map(checkItem));
    }
    box.replaceChildren(list);
  } catch (e) {
    box.replaceChildren(h("p", { class: "error" }, errText(e)));
  }
}

function actionCard(inst: Install, onLaunched: () => void): HTMLElement {
  const note = h("p", { class: "muted" });
  const willInstall = !inst.has_checkout;
  const label = willInstall
    ? t("下载并安装 Claudestra", "Download and install Claudestra")
    : inst.daemons_installed ? t("重新运行安装向导", "Run setup again") : t("在终端里运行安装向导", "Run setup in Terminal");
  const go = button(label, willInstall ? "download" : "terminal", async (b) => {
    b.disabled = true;
    try {
      await invoke<string>("launch_setup");
      note.textContent = t(
        "已在「终端」里打开。按提示回答几个问题；装好后这里和菜单栏会自动变绿。",
        "Opened in Terminal. Answer the prompts there; this window and the menu bar turn green once it's done.");
      onLaunched();
    } catch (e) {
      note.textContent = errText(e);
    } finally {
      b.disabled = false;
    }
  }, "primary");
  const explain = willInstall
    ? t(`会在终端里运行官方安装脚本（install.sh），把 Claudestra 装到 ${inst.repo}，缺的依赖用 Homebrew 补上，装完接着进安装向导。`,
      `Runs the official install.sh in Terminal: clones Claudestra into ${inst.repo}, adds missing tools via Homebrew, then continues into setup.`)
    : t(`安装向导要在终端里一问一答（选入口、手机访问方式、同意权限说明），所以在「终端」里打开 ${inst.repo} 的 bun run setup。`,
      `Setup is an interactive Q&A (entry point, phone access, permission consent), so it runs as bun run setup in ${inst.repo} inside Terminal.`);
  return h("section", { class: "card" }, h("h3", {}, t("安装", "Install")), h("p", {}, explain), go, note);
}

export function renderSetup(root: HTMLElement, inst: Install, onLaunched: () => void): void {
  const deps = h("div", {});
  const recheck = button(t("重新检测", "Check again"), "refresh", () => void loadDeps(deps, inst), "ghost");
  root.replaceChildren(
    h("section", { class: "card" }, h("div", { class: "card-head" }, h("h3", {}, t("依赖", "Dependencies")), recheck), deps),
    actionCard(inst, onLaunched),
    h("p", { class: "muted small" },
      t("这个小程序只看、只重启，不改你的配置；真正的安装和改动都由终端里的安装向导完成，它会先列出要改哪些地方。",
        "This app only shows status and restarts services; all changes are made by the setup wizard in Terminal, which lists them first.")));
  void loadDeps(deps, inst);
}
