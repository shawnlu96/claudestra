/**
 * 项目地图配置（project-map-PDSTATE2）：产品板按「板块」给 feature 分组、卡级冻结名单，PM 直接手改 JSON，不加 CLI。
 * 文件 ~/.claude-orchestrator/project-map.json，形如 { "<项目 id>": { "areas": [{ id, name, features }], "frozenTasks": ["T1"] } }。
 * 每次调用都现读（文件小，productBoard 也不是热路径），改完下一次刷新就生效。
 * 不存在 → 空配置、不打日志；坏 JSON → 空配置、同一个坏文件只报一次；单个不合格的板块只丢它自己、只 warn 一次。
 * 冻结名单只影响产品板的显示和状态，不让调度器停发动作。
 */
import { statePath } from "./paths.js";
import { readJsonStateSync, reportCorrupt } from "./state-file.js";

export const PROJECT_MAP_PATH = statePath("project-map.json");
const AREA_ID = /^[a-z][a-z0-9-]{0,31}$/;
const AREA_NAME_MAX = 20, AREAS_MAX = 12, FROZEN_MAX = 200;

interface Area { id: string; name: string; features: string[] }
export interface ProjectMapConfig { areas: Area[]; frozen: ReadonlySet<string> }

const EMPTY: ProjectMapConfig = { areas: [], frozen: new Set() };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// 每次都现读，同一条毛病不能每次刷新都喊一遍：按 path + 内容认，只 warn 一次
const warned = new Set<string>();
function warnOnce(path: string, msg: string): void {
  const key = `${path}\0${msg}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`⚠️ [project-map] ${path}: ${msg}`);
}

function areaOk(a: unknown): a is Area {
  if (!record(a) || typeof a.id !== "string" || !AREA_ID.test(a.id) || typeof a.name !== "string") return false;
  const len = [...a.name.trim()].length;
  return len >= 1 && len <= AREA_NAME_MAX && Array.isArray(a.features) && a.features.every((f) => typeof f === "string");
}

/** 不合格的板块丢掉；同一个 feature 出现在两个板块里只留在第一个 */
function parseAreas(raw: unknown, path: string, project: string): Area[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) { warnOnce(path, `${project}.areas 不是数组，已忽略`); return []; }
  const areas: Area[] = [], ids = new Set<string>(), seen = new Set<string>();
  raw.forEach((a, i) => {
    if (!areaOk(a)) return warnOnce(path, `${project}.areas[${i}] 不合格（id 形如 ${AREA_ID.source}、name 1–${AREA_NAME_MAX} 字、features 是字符串数组），已丢掉：${JSON.stringify(a)}`);
    if (ids.has(a.id)) return warnOnce(path, `${project}.areas[${i}] id「${a.id}」重复，已丢掉`);
    if (areas.length >= AREAS_MAX) return warnOnce(path, `${project}.areas 超过 ${AREAS_MAX} 个，第 ${i + 1} 个起丢掉`);
    ids.add(a.id);
    areas.push({ id: a.id, name: a.name.trim(), features: a.features.filter((f) => !seen.has(f) && (seen.add(f), true)) });
  });
  return areas;
}

function parseFrozen(raw: unknown, path: string, project: string): ReadonlySet<string> {
  if (raw === undefined) return new Set();
  if (!Array.isArray(raw)) { warnOnce(path, `${project}.frozenTasks 不是数组，已忽略`); return new Set(); }
  const ids = raw.filter((v): v is string => typeof v === "string");
  if (ids.length !== raw.length) warnOnce(path, `${project}.frozenTasks 里有非字符串，已跳过`);
  if (ids.length > FROZEN_MAX) warnOnce(path, `${project}.frozenTasks 超过 ${FROZEN_MAX} 个，只取前 ${FROZEN_MAX} 个`);
  return new Set(ids.slice(0, FROZEN_MAX));
}

/** 本机项目的板块与冻结名单；永不抛 */
export function projectMapConfig(project: string, path = PROJECT_MAP_PATH): ProjectMapConfig {
  const r = readJsonStateSync(path, record);
  if (r.status === "missing") return EMPTY;
  if (r.status === "corrupt") { reportCorrupt(path, r.error, "project-map"); return EMPTY; }
  const entry = (r.data as Record<string, unknown>)[project];
  if (entry === undefined) return EMPTY;
  if (!record(entry)) { warnOnce(path, `${project} 不是对象，已忽略`); return EMPTY; }
  return { areas: parseAreas(entry.areas, path, project), frozen: parseFrozen(entry.frozenTasks, path, project) };
}
