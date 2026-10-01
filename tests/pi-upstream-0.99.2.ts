import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pi 0.99.2 上游纯函数的原样移植，给测试当「pi 实际怎么解析」的判据（不在测试里猜 argv 子串）。
 * 来源：registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.99.2.tgz（SHA-1 6f95461d41661aea1243f6cc2ac0ace8497d21f7，
 * MIT，版权声明与许可全文见 tests/pi-upstream-0.99.2.LICENSE.txt）。函数体逐行照抄 dist 里的同名函数，只补了 TS 类型标注；
 * 行号写在每个函数上。pi 升级时对着新版 dist 重新抄一遍。
 */

// dist/cli/args.js:6-9
const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function isValidThinkingLevel(level: string): boolean {
    return VALID_THINKING_LEVELS.includes(level);
}

// dist/cli/args.js:14-252
export function parseArgs(args: string[]): any {
    const result: any = {
        messages: [],
        fileArgs: [],
        unknownFlags: new Map(),
        diagnostics: [],
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--") {
            for (const positionalArg of args.slice(i + 1)) {
                if (positionalArg.startsWith("@")) {
                    result.fileArgs.push(positionalArg.slice(1));
                }
                else {
                    result.messages.push(positionalArg);
                }
            }
            break;
        }
        else if (arg === "--help" || arg === "-h") {
            result.help = true;
        }
        else if (arg === "--version" || arg === "-v") {
            result.version = true;
        }
        else if (arg === "--mode") {
            const mode = args[i + 1];
            if (mode === undefined || mode.startsWith("-")) {
                result.diagnostics.push({ type: "error", message: "--mode requires text, json, or rpc" });
                continue;
            }
            i++;
            if (mode !== "text" && mode !== "json" && mode !== "rpc") {
                result.diagnostics.push({
                    type: "error",
                    message: `Invalid mode "${mode}". Valid values: text, json, rpc`,
                });
                continue;
            }
            result.mode = mode;
        }
        else if (arg === "--continue" || arg === "-c") {
            result.continue = true;
        }
        else if (arg === "--resume" || arg === "-r") {
            result.resume = true;
        }
        else if (arg === "--provider" && i + 1 < args.length) {
            result.provider = args[++i];
        }
        else if (arg === "--model" && i + 1 < args.length) {
            result.model = args[++i];
        }
        else if (arg === "--api-key" && i + 1 < args.length) {
            result.apiKey = args[++i];
        }
        else if (arg === "--system-prompt" && i + 1 < args.length) {
            result.systemPrompt = args[++i];
        }
        else if (arg === "--append-system-prompt" && i + 1 < args.length) {
            result.appendSystemPrompt = result.appendSystemPrompt ?? [];
            result.appendSystemPrompt.push(args[++i]);
        }
        else if (arg === "--name" || arg === "-n") {
            if (i + 1 < args.length) {
                result.name = args[++i];
            }
            else {
                result.diagnostics.push({ type: "error", message: "--name requires a value" });
            }
        }
        else if (arg === "--no-session") {
            result.noSession = true;
        }
        else if (arg === "--session" && i + 1 < args.length) {
            result.session = args[++i];
        }
        else if (arg === "--session-id" && i + 1 < args.length) {
            result.sessionId = args[++i];
        }
        else if (arg === "--fork" && i + 1 < args.length) {
            result.fork = args[++i];
        }
        else if (arg === "--session-dir" && i + 1 < args.length) {
            result.sessionDir = args[++i];
        }
        else if (arg === "--models" && i + 1 < args.length) {
            result.models = args[++i].split(",").map((s) => s.trim());
        }
        else if (arg === "--no-tools" || arg === "-nt") {
            result.noTools = true;
        }
        else if (arg === "--no-builtin-tools" || arg === "-nbt") {
            result.noBuiltinTools = true;
        }
        else if ((arg === "--tools" || arg === "-t") && i + 1 < args.length) {
            result.tools = args[++i]
                .split(",")
                .map((s) => s.trim())
                .filter((name) => name.length > 0);
        }
        else if ((arg === "--exclude-tools" || arg === "-xt") && i + 1 < args.length) {
            result.excludeTools = args[++i]
                .split(",")
                .map((s) => s.trim())
                .filter((name) => name.length > 0);
        }
        else if (arg === "--thinking" && i + 1 < args.length) {
            const level = args[++i];
            if (isValidThinkingLevel(level)) {
                result.thinking = level;
            }
            else {
                result.diagnostics.push({
                    type: "warning",
                    message: `Invalid thinking level "${level}". Valid values: ${VALID_THINKING_LEVELS.join(", ")}`,
                });
            }
        }
        else if (arg === "--print" || arg === "-p") {
            result.print = true;
            const next = args[i + 1];
            if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
                result.messages.push(next);
                i++;
            }
        }
        else if (arg === "--export" && i + 1 < args.length) {
            result.export = args[++i];
        }
        else if ((arg === "--extension" || arg === "-e") && i + 1 < args.length) {
            result.extensions = result.extensions ?? [];
            result.extensions.push(args[++i]);
        }
        else if (arg === "--no-extensions" || arg === "-ne") {
            result.noExtensions = true;
        }
        else if (arg === "--skill" && i + 1 < args.length) {
            result.skills = result.skills ?? [];
            result.skills.push(args[++i]);
        }
        else if (arg === "--prompt-template" && i + 1 < args.length) {
            result.promptTemplates = result.promptTemplates ?? [];
            result.promptTemplates.push(args[++i]);
        }
        else if (arg === "--theme" && i + 1 < args.length) {
            result.themes = result.themes ?? [];
            result.themes.push(args[++i]);
        }
        else if (arg === "--use-theme") {
            const themeName = args[i + 1];
            if (themeName === undefined || themeName.startsWith("-")) {
                result.diagnostics.push({ type: "error", message: "--use-theme requires a theme name" });
            }
            else {
                result.useTheme = themeName;
                i++;
            }
        }
        else if (arg === "--no-skills" || arg === "-ns") {
            result.noSkills = true;
        }
        else if (arg === "--no-prompt-templates" || arg === "-np") {
            result.noPromptTemplates = true;
        }
        else if (arg === "--no-themes") {
            result.noThemes = true;
        }
        else if (arg === "--no-context-files" || arg === "-nc") {
            result.noContextFiles = true;
        }
        else if (arg === "--list-models") {
            // Check if next arg is a search pattern (not a flag or file arg)
            if (i + 1 < args.length && !args[i + 1].startsWith("-") && !args[i + 1].startsWith("@")) {
                result.listModels = args[++i];
            }
            else {
                result.listModels = true;
            }
        }
        else if (arg === "--tui-mode") {
            const mode = args[i + 1];
            if (mode === "regular" || mode === "fullscreen") {
                result.tuiMode = mode;
                i++;
            }
            else if (mode === undefined || mode.startsWith("-")) {
                result.diagnostics.push({ type: "error", message: "--tui-mode requires regular or fullscreen" });
            }
            else {
                i++;
                result.diagnostics.push({
                    type: "error",
                    message: `Invalid TUI mode "${mode}". Valid values: regular, fullscreen`,
                });
            }
        }
        else if (arg === "--verbose") {
            result.verbose = true;
        }
        else if (arg === "--approve" || arg === "-a") {
            result.projectTrustOverride = true;
        }
        else if (arg === "--no-approve" || arg === "-na") {
            result.projectTrustOverride = false;
        }
        else if (arg === "--offline") {
            result.offline = true;
        }
        else if (arg.startsWith("@")) {
            result.fileArgs.push(arg.slice(1)); // Remove @ prefix
        }
        else if (arg.startsWith("--")) {
            const eqIndex = arg.indexOf("=");
            if (eqIndex !== -1) {
                result.unknownFlags.set(arg.slice(2, eqIndex), arg.slice(eqIndex + 1));
            }
            else {
                const flagName = arg.slice(2);
                const next = args[i + 1];
                if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
                    result.unknownFlags.set(flagName, next);
                    i++;
                }
                else {
                    result.unknownFlags.set(flagName, true);
                }
            }
        }
        else if (arg.startsWith("-") && !arg.startsWith("--")) {
            result.diagnostics.push({ type: "error", message: `Unknown option: ${arg}` });
        }
        else if (!arg.startsWith("-")) {
            result.messages.push(arg);
        }
    }
    return result;
}

// dist/utils/paths.js:6（UNICODE_SPACES）、:59-82（normalizePath；Windows 分支依赖的 normalizeWindowsShellPath 不移植，测试只在 POSIX 跑）
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const normalizeWindowsShellPath = (p: string) => p;
export function normalizePath(input: string, options: any = {}): string {
    let normalized = options.trim ? input.trim() : input;
    if (options.normalizeUnicodeSpaces) {
        normalized = normalized.replace(UNICODE_SPACES, " ");
    }
    if (options.stripAtPrefix && normalized.startsWith("@")) {
        normalized = normalized.slice(1);
    }
    if (process.platform === "win32") {
        normalized = normalizeWindowsShellPath(normalized);
    }
    if (options.expandTilde ?? true) {
        const home = options.homeDir ?? homedir();
        if (normalized === "~")
            return home;
        if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
            return join(home, normalized.slice(2));
        }
    }
    if (/^file:\/\//.test(normalized)) {
        return fileURLToPath(normalized);
    }
    return normalized;
}

// dist/config.js:450-456（getAgentDir，env 作参数传入而不是读 process.env；CONFIG_DIR_NAME = ".pi"）
export function getAgentDir(env: Record<string, string | undefined>): string {
    const envDir = env.PI_CODING_AGENT_DIR;
    if (envDir) {
        return normalizePath(envDir);
    }
    return join(homedir(), ".pi", "agent");
}

// dist/extensions/mcp/tools.js:30（MAX_TOOL_NAME_LENGTH）、:49-55（createMcpToolName）
const MAX_TOOL_NAME_LENGTH = 64;
export function createMcpToolName(server: string, tool: string, isTaken: (n: string) => boolean = () => false): string {
    const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
    if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name))
        return name;
    const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
    return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

/**
 * 工具筛选，三处拼起来：dist/main.js:420-431（parsed → options.tools / noTools / excludeTools）、dist/core/sdk.js:145-146
 * （allowedToolNames / excludedToolNames）、dist/core/agent-session.js:2753（isAllowedTool）。返回 pi 会不会留下这个工具。
 */
export function piKeepsTool(parsed: any, name: string): boolean {
    const options: any = {};
    if (parsed.noTools) {
        options.noTools = "all";
    }
    else if (parsed.noBuiltinTools) {
        options.noTools = "builtin";
    }
    if (parsed.tools) {
        options.tools = [...parsed.tools];
    }
    if (parsed.excludeTools) {
        options.excludeTools = [...parsed.excludeTools];
    }
    const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
    const excludedToolNames = options.excludeTools ? new Set(options.excludeTools) : undefined;
    const allowed = allowedToolNames ? new Set(allowedToolNames) : undefined;
    return (!allowed || allowed.has(name)) && !excludedToolNames?.has(name);
}
