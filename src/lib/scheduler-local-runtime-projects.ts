/** Queue admission uses a fresh project snapshot; an unreadable file cannot reuse a previously allowed repository. */
import { PROJECTS_PATH, type ProjectsData } from "./projects.js";
import { readJsonState } from "./state-file.js";

export async function currentLocalProjectDirs(project: string, path = PROJECTS_PATH): Promise<string[]> {
  const state = await readJsonState(path, (raw) => !!raw && typeof raw === "object"
    && Array.isArray((raw as Partial<ProjectsData>).projects));
  if (state.status !== "ok") throw new Error("无法确认当前项目目录，取消排队开卡");
  const entry = (state.data as ProjectsData).projects.find((p) => p?.id === project);
  if (!entry) return [];
  if (!Array.isArray(entry.dirs) || entry.dirs.some((dir) => typeof dir !== "string" || !dir)) {
    throw new Error("当前项目目录格式不合法，取消排队开卡");
  }
  return entry.dirs;
}
