/**
 * 版本信息：直托管问 bridge `GET /api/v1/version`（§13.2：{version, commit, apiVersion, minClient}）；
 * 中继托管的 bundle 由中继统一发布，版本以 /app-config.json 为准（那边没有 apiVersion——那是机器的事）。
 */
import { loadAppConfig } from "@/lib/app-config";
import { api } from "./client";

export interface VersionInfo {
  version: string;
  commit: string;
  // CONTRACT: bridge / 中继若给出 webCommit（最后一个动过 web/ 的提交），前端用它精确判「bundle 是否滞后」；缺省退回 commit。
  webCommit?: string;
  /** 机器的 API 版本；老 bridge 没这个端点时为 undefined */
  apiVersion?: number;
  /** 机器要求的最低前端版本（semver） */
  minClient?: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** 当前机器（直托管 = bridge；中继 = 中继发布的前端）的版本；中继模式重拉 app-config，否则常驻页面永远看不到新 webCommit */
export async function fetchVersion(): Promise<VersionInfo> {
  const cfg = await loadAppConfig({ refresh: true });
  if (cfg.mode === "relay") return { version: cfg.version, commit: cfg.commit ?? "", ...(cfg.webCommit ? { webCommit: cfg.webCommit } : {}) };
  const j = await api<Record<string, unknown>>("/version", { timeoutMs: 8_000 });
  return {
    version: str(j.version),
    commit: str(j.commit),
    ...(str(j.webCommit) ? { webCommit: str(j.webCommit) } : {}),
    ...(typeof j.apiVersion === "number" ? { apiVersion: j.apiVersion } : {}),
    ...(str(j.minClient) ? { minClient: str(j.minClient) } : {}),
  };
}

/** 当前机器 bridge 的版本（中继模式下也要问机器——「这台机器需要升级」看的是它） */
export function fetchMachineVersion(): Promise<VersionInfo> {
  return api<Record<string, unknown>>("/version", { timeoutMs: 8_000 }).then((j) => ({
    version: str(j.version),
    commit: str(j.commit),
    ...(typeof j.apiVersion === "number" ? { apiVersion: j.apiVersion } : {}),
    ...(str(j.minClient) ? { minClient: str(j.minClient) } : {}),
  }));
}
