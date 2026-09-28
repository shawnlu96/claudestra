export interface Install {
  repo: string;
  bun: string;
  path: string;
  daemons_installed: boolean;
  has_checkout: boolean;
  cli_available: boolean;
}

export interface AppInfo { install: Install; zh: boolean; version: string }

export interface Daemon { label: string; name: string; status: string; running: boolean; pid: number | null; detail: string }

export interface Status {
  ok: boolean;
  overall: string;
  daemons: Daemon[];
  webUrl: string;
  logDir: string;
  repoRoot: string;
  configured: boolean;
}

export interface Check { group: string; name: string; status: string; detail: string; fix?: string }

export interface ChecksResult { ok: boolean; checks: Check[] }

export interface Tool { name: string; found: boolean; version?: string; error?: string }

export interface RestartResult { ok: boolean; results: { label: string; ok: boolean; error?: string }[] }
