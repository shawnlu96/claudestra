/** The private entry reads the center host from a local owner-only file; only its absolute path is passed, never its content. */
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { statePath } from "./paths.js";

export const CENTER_TARGET_MISSING = "中心部署目标文件缺失或权限不对";
export const centerTargetFile = () => statePath("center-deploy-target.env");

/** Absolute path when the file is a regular file owned by this user with mode 0600; otherwise null. */
export function centerDeployTarget(path = centerTargetFile(), uid = process.getuid?.() ?? -1): string | null {
  try {
    const s = lstatSync(path);
    return s.isFile() && s.uid === uid && (s.mode & 0o777) === 0o600 ? resolve(path) : null;
  } catch { return null; /* Missing or unreadable metadata is the same refusal. */ }
}
