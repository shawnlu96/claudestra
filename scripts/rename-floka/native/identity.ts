/**
 * rename.native:iOS / desktop 新 App 身份的计划与前提核对(owner 10-12 选 B:新 bundle = 新 App 身份)。
 * 本模块只读不写:off 报旧身份;observe 出新身份计划;on 再核平台配置,缺签名 / APNs 前提就拒绝发布步骤。
 * 平台配置齐了也只列人工步骤——本工具不签名、不发布、不连 APNs,也不改仓库里的构建配置。
 * 新值是建议值(identifiers.json 的 bundle.* 条目),由 PM 核定平台所有权后另切。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type NativeMode = "off" | "observe" | "on";
export const NATIVE_ITEM = "rename.native";

export const OLD_IDENTITY = {
  ios: { bundleId: "com.claudestra.app", displayName: "Claudestra", apnsTopic: "com.claudestra.app", schemes: ["claudestra"] },
  desktop: { identifier: "com.claudestra.desktop", productName: "Claudestra" },
} as const;

export const PROPOSED_IDENTITY = {
  ios: { bundleId: "ai.floka.app", displayName: "Floka", apnsTopic: "ai.floka.app", schemes: ["floka", "claudestra"] },
  desktop: { identifier: "ai.floka.desktop", productName: "Floka" },
} as const;

/** iOS 壳认的邀请 scheme:旧壳、新壳都两个一起认(AppDelegate.swift 的 inviteSchemes 与此一致) */
export const INVITE_SCHEMES = ["claudestra", "floka"] as const;

/** 不随本卡变的东西:relay 域、VAPID、壳里的 UserDefaults 键 */
const UNCHANGED = [
  { what: "relay 域名", why: "PM 定:不换 relay 域" },
  { what: "VAPID 密钥对", why: "PM 定:不换 VAPID;Web Push 订阅不受 App 身份影响" },
  { what: "UserDefaults 键 cstra.serverURL", why: "新壳沿用同一个键,导入时原样写入" },
];

/** 平台配置:只放引用(团队 ID、描述文件名、key ID、钥匙串条目名),不放凭据本体 */
export interface PlatformConfig {
  ios?: { teamId?: string; provisioningProfile?: string; apnsKeyId?: string; apnsTopic?: string; apsEnvironment?: string };
  desktop?: { signingIdentity?: string; notaryProfile?: string };
}

interface Prerequisite { id: string; need: string; status: "declared" | "missing" | "manual"; detail?: string }
interface FileChange { file: string; key: string; from: string; to: string; note?: string }
interface PublishStep { id: string; what: string; status: "refused" | "manual" }

export interface IdentityResult {
  item: typeof NATIVE_ITEM;
  mode: NativeMode;
  status: "off" | "planned" | "blocked";
  writes: 0;
  identity: typeof OLD_IDENTITY | { from: typeof OLD_IDENTITY; to: typeof PROPOSED_IDENTITY };
  fileChanges: FileChange[];
  prerequisites: Prerequisite[];
  publishSteps: PublishStep[];
  publishReady: boolean;
  releaseClaim: "none";
  refusals: string[];
  sandbox: { inherited: false; note: string };
  unchanged: typeof UNCHANGED;
}

export const SANDBOX_NOTE = "新 bundle 是新 App:sandbox 容器、UserDefaults、Keychain、WebView 数据目录都不会从旧 App 继承;配置只能经导入带过去,推送须在新 topic 下重新注册";

const TEAM_RE = /^[A-Z0-9]{10}$/;
const SECRET_RE = /-----BEGIN|PRIVATE KEY|\.p8$|\.p12$/i;

/** 平台配置只许是短字符串引用;看着像凭据本体或密钥文件就拒读 */
function assertNoSecrets(platform: PlatformConfig): void {
  for (const group of [platform.ios, platform.desktop]) {
    for (const [k, v] of Object.entries(group ?? {})) {
      if (typeof v !== "string") throw new Error(`平台配置 ${k} 必须是字符串`);
      if (SECRET_RE.test(v) || v.length > 200) throw new Error(`平台配置 ${k} 像凭据本体:这里只放引用,不放凭据`);
    }
  }
}

function prerequisites(platform: PlatformConfig): Prerequisite[] {
  const ios = platform.ios ?? {}, desk = platform.desktop ?? {};
  const to = PROPOSED_IDENTITY;
  const check = (id: string, need: string, ok: boolean, detail?: string): Prerequisite =>
    ({ id, need, status: ok ? "declared" : "missing", ...(detail && !ok ? { detail } : {}) });
  const manual = (id: string, need: string): Prerequisite => ({ id, need, status: "manual" });
  return [
    check("ios.signing.team", "新 bundle 所属 Apple 开发者团队 ID", TEAM_RE.test(ios.teamId ?? ""), "10 位大写字母数字"),
    check("ios.signing.profile", `${to.ios.bundleId} 的描述文件(含 Push Notifications 能力)`, !!ios.provisioningProfile?.trim()),
    check("ios.entitlements.aps", "App.entitlements 的 aps-environment(上架用 production)",
      ios.apsEnvironment === "development" || ios.apsEnvironment === "production", "development 或 production"),
    check("ios.apns.key", "能给新 topic 发推送的 APNs key ID", TEAM_RE.test(ios.apnsKeyId ?? ""), "10 位大写字母数字"),
    check("ios.apns.topic", "APNs topic = 新 bundle id", ios.apnsTopic === to.ios.apnsTopic, `须为 ${to.ios.apnsTopic}`),
    manual("ios.url-scheme", `新壳注册 ${to.ios.schemes.join(" + ")};落地页在新壳铺开前继续发旧 scheme`),
    manual("ios.sandbox", SANDBOX_NOTE),
    manual("ios.push-coexist", "旧壳设备仍按旧 topic 推送:服务端须按设备记录的 topic 发,旧推送凭据不删"),
    manual("config.import", "旧壳导出配置 → 导入新壳(import 子命令);真机导出入口另排"),
    check("desktop.signing", "Developer ID Application 签名身份", !!desk.signingIdentity?.trim()),
    check("desktop.notary", "公证用的 notarytool 钥匙串条目名", !!desk.notaryProfile?.trim()),
    manual("desktop.webview-data", `换 identifier = 换 WebView 数据目录,${OLD_IDENTITY.desktop.identifier} 的数据要首启搬迁`),
  ];
}

function fileChanges(): FileChange[] {
  const from = OLD_IDENTITY, to = PROPOSED_IDENTITY;
  return [
    { file: "native/capacitor.config.ts", key: "appId", from: from.ios.bundleId, to: to.ios.bundleId },
    { file: "native/capacitor.config.ts", key: "appName", from: from.ios.displayName, to: to.ios.displayName },
    { file: "native/ios/App/App.xcodeproj/project.pbxproj", key: "PRODUCT_BUNDLE_IDENTIFIER(Debug + Release)", from: from.ios.bundleId, to: to.ios.bundleId },
    { file: "native/ios/App/App/Info.plist", key: "CFBundleDisplayName", from: from.ios.displayName, to: to.ios.displayName },
    { file: "native/ios/App/App/App.entitlements", key: "aps-environment", from: "development", to: "production", note: "上架包才换" },
    { file: "native/scripts/build-ios.sh", key: "BUNDLE_ID", from: from.ios.bundleId, to: to.ios.bundleId },
    { file: "src/lib/apns.ts", key: "DEFAULT_APNS_TOPIC", from: from.ios.apnsTopic, to: to.ios.apnsTopic, note: "旧壳设备仍须按旧 topic 发" },
    { file: "desktop/src-tauri/tauri.conf.json", key: "identifier", from: from.desktop.identifier, to: to.desktop.identifier },
    { file: "desktop/src-tauri/tauri.conf.json", key: "productName", from: from.desktop.productName, to: to.desktop.productName },
  ];
}

const PUBLISH_STEPS: Omit<PublishStep, "status">[] = [
  { id: "ios.register-bundle", what: `在开发者后台登记 ${PROPOSED_IDENTITY.ios.bundleId}(含 Push)` },
  { id: "ios.sign-archive", what: "用新描述文件签名归档" },
  { id: "ios.apns-verify", what: "新 topic 下实机推送一次" },
  { id: "ios.store-listing", what: "商店新 App 条目" },
  { id: "desktop.sign-notarize", what: "新 identifier 的桌面包签名 + 公证" },
];

export function planNativeIdentity(opts: { mode: NativeMode; platform?: PlatformConfig }): IdentityResult {
  const { mode } = opts;
  const base = {
    item: NATIVE_ITEM as typeof NATIVE_ITEM, mode, writes: 0 as const, releaseClaim: "none" as const,
    sandbox: { inherited: false as const, note: SANDBOX_NOTE }, unchanged: UNCHANGED,
  };
  if (mode === "off") {
    return { ...base, status: "off", identity: OLD_IDENTITY, fileChanges: [], prerequisites: [], publishSteps: [], publishReady: false, refusals: [] };
  }
  const platform = opts.platform ?? {};
  assertNoSecrets(platform);
  const pre = prerequisites(platform);
  const missing = pre.filter((p) => p.status === "missing");
  const refusals = mode === "on" ? missing.map((p) => `${p.id}: 缺 ${p.need}${p.detail ? `(${p.detail})` : ""},发布步骤不放行`) : [];
  const blocked = refusals.length > 0;
  const publishSteps: PublishStep[] = mode === "on" ? PUBLISH_STEPS.map((s) => ({ ...s, status: blocked ? "refused" : "manual" })) : [];
  return {
    ...base, status: blocked ? "blocked" : "planned", identity: { from: OLD_IDENTITY, to: PROPOSED_IDENTITY },
    fileChanges: fileChanges(), prerequisites: pre, publishSteps, publishReady: mode === "on" && !blocked, refusals,
  };
}

/** 邀请链接 <scheme>://join#<码> → 码;与 AppDelegate.swift 的判断一致 */
export function parseInviteUrl(raw: string): string | null {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)[^#]*#(.+)$/.exec(raw);
  if (!m) return null;
  const [, scheme, host, code] = m;
  return (INVITE_SCHEMES as readonly string[]).includes(scheme.toLowerCase()) && host === "join" ? code : null;
}

interface StaticCheck { id: string; file: string; ok: boolean; detail: string }

/** 仓库里的构建配置静态校验:旧身份未被切换、新旧 scheme 都注册且处理、配置文件可解析。只读 */
export function checkStaticConfig(root: string): { ok: boolean; checks: StaticCheck[] } {
  const read = (f: string) => readFileSync(join(root, f), "utf8");
  const checks: StaticCheck[] = [];
  const add = (id: string, file: string, ok: boolean, detail: string) => checks.push({ id, file, ok, detail });
  const old = OLD_IDENTITY;

  const cap = "native/capacitor.config.ts";
  add("identity.capacitor", cap, new RegExp(`appId:\\s*"${old.ios.bundleId.replace(/\./g, "\\.")}"`).test(read(cap)), `appId 仍是 ${old.ios.bundleId}`);
  const pbx = "native/ios/App/App.xcodeproj/project.pbxproj";
  const ids = [...read(pbx).matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((m) => m[1]);
  add("identity.pbxproj", pbx, ids.length > 0 && ids.every((v) => v === old.ios.bundleId), `PRODUCT_BUNDLE_IDENTIFIER 全是 ${old.ios.bundleId}(${ids.length} 处)`);
  const build = "native/scripts/build-ios.sh";
  add("identity.build-script", build, read(build).includes(`BUNDLE_ID="${old.ios.bundleId}"`), "构建脚本不自动切新 bundle");
  const tauri = "desktop/src-tauri/tauri.conf.json";
  let tauriId = "";
  try { tauriId = String((JSON.parse(read(tauri)) as { identifier?: unknown }).identifier); } catch { /* 下面判 false */ }
  add("identity.tauri", tauri, tauriId === old.desktop.identifier, `identifier 仍是 ${old.desktop.identifier},JSON 可解析`);

  const plist = "native/ios/App/App/Info.plist";
  const schemes = [...(/<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(read(plist))?.[1] ?? "").matchAll(/<string>([^<]*)<\/string>/g)]
    .map((m) => m[1]).sort();
  add("scheme.info-plist", plist, JSON.stringify(schemes) === JSON.stringify([...INVITE_SCHEMES].sort()), `CFBundleURLSchemes = ${schemes.join(", ")}`);
  const delegate = "native/ios/App/App/AppDelegate.swift";
  const listed = /inviteSchemes: Set<String> = \[([^\]]*)\]/.exec(read(delegate))?.[1].match(/"[^"]*"/g)?.map((s) => s.slice(1, -1)).sort() ?? [];
  add("scheme.app-delegate", delegate, JSON.stringify(listed) === JSON.stringify([...INVITE_SCHEMES].sort()), `inviteSchemes = ${listed.join(", ")}`);
  const ent = "native/ios/App/App/App.entitlements";
  add("entitlements.aps", ent, /<key>aps-environment<\/key>\s*<string>(development|production)<\/string>/.test(read(ent)), "aps-environment 在");
  return { ok: checks.every((c) => c.ok), checks };
}
