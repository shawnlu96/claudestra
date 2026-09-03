import type Database from "better-sqlite3";

/**
 * per-agent 前端配置。当前只有 init_message：clear 会话后自动发送的「开机指令」。
 *
 * 这是**用户层**的数据——Claudestra 产品（bridge/manager）对它零感知：clear 端点
 * 只做原生 /clear，开机指令由前端在 clear 成功后作为普通消息发出（可见、可审计）。
 * 知识注入（如项目图谱加载）藏在指令文本里，产品不知道图谱的存在。
 */
export function runSettingsMigrations(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_settings (
      agent TEXT PRIMARY KEY,
      init_message TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    )
  `);
  // 用户个人资料（owner 2026-07-14:设置里自定义头像+昵称,显示在对话里）。
  // 单账号单行表;avatar 是前端压缩后的 data URL(128px jpeg,~15KB),
  // 存库省去文件管理,GET 直出。
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      nickname TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    )
  `);
  // Skill 快捷入口偏好(owner 2026-07-15:「斜杠太隐蔽,加按钮+管理页」)。
  // pinned=置顶(updated_at 定置顶组内顺序),used_count=使用频次(排序依据)。
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_prefs (
      name TEXT PRIMARY KEY,
      pinned INTEGER NOT NULL DEFAULT 0,
      used_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `);
  // Claude 侧也可自定义头像+名称(owner 同日追加)。ALTER 幂等:查列缺才加。
  const cols = (db.prepare("PRAGMA table_info(user_profile)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("claude_nickname")) {
    db.exec("ALTER TABLE user_profile ADD COLUMN claude_nickname TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.includes("claude_avatar")) {
    db.exec("ALTER TABLE user_profile ADD COLUMN claude_avatar TEXT NOT NULL DEFAULT ''");
  }
  // Web Push 订阅(owner 2026-07-16「做 pwa 推送」)。原生 VAPID 自托管,零第三方。
  // endpoint 为主键(浏览器换订阅=新 endpoint);keys 是 PushSubscription 的
  // p256dh/auth JSON;410/404 失效时由 dispatcher 自动清理。
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      keys TEXT NOT NULL,
      ua TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )
  `);
  // v2.21.1+ 跨端已读对账(owner 2026-08-30「一处点完,他处取消通知」):
  // agent → 最近一次已读时刻(epoch ms)。已读信号源:打开会话/点通知/Discord
  // 里说话。dismiss push 与打开 App 时的补清都以它为准。
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_read (
      agent TEXT PRIMARY KEY,
      ts INTEGER NOT NULL
    )
  `);
  // v2.22+ 原生壳(native/)的 APNs 设备 token。token 为主键(同设备换 token = 新行,
  // 旧 token 由 APNs 回 BadDeviceToken/410 时清理);device 是自报的设备名。
  db.exec(`
    CREATE TABLE IF NOT EXISTS apns_devices (
      token TEXT PRIMARY KEY,
      device TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      last_seen TEXT NOT NULL
    )
  `);
  // 登录安全配置(owner 2026-08-09「设置里可选启用」)。单账号单行表,存各安全
  // 功能的开关。默认:累进封禁开(纯加固,零登录破坏)、TOTP/Passkey 关(要用户
  // 主动 enroll)。totp_secret 是激活后的密钥(base32),未启用时为空。
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      brute_force_on INTEGER NOT NULL DEFAULT 1,
      totp_on INTEGER NOT NULL DEFAULT 0,
      totp_secret TEXT NOT NULL DEFAULT '',
      passkey_on INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT ''
    )
  `);
  db.exec("INSERT OR IGNORE INTO auth_config (id, updated_at) VALUES (1, '')");
  // 登录失败累进封禁状态(持久化,跨重启不清零——内存态重启即失忆,给爆破留窗口)。
  // key=客户端 IP(见 login route),fail_count 连续失败数,locked_until 锁定到期
  // (epoch ms,0=未锁)。登录成功即删行。
  db.exec(`
    CREATE TABLE IF NOT EXISTS login_lockouts (
      k TEXT PRIMARY KEY,
      fail_count INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `);
  // TOTP 恢复码（第二期）。丢手机/换认证器时的唯一自救途径——没有它，启用 2FA
  // 后设备一丢就彻底进不来（这套系统没有第二个管理员能帮你重置）。
  // 只存 sha256 哈希，明文仅在生成那一刻展示一次；used_at 非空 = 已用掉（一次性）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS totp_recovery_codes (
      code_hash TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      used_at TEXT
    )
  `);
  // Passkey / WebAuthn 凭据（第三期）。
  // **rp_id 必须随凭据存**：WebAuthn 凭据绑定在 rpID 上且不可跨域，而这套 web
  // 有多个入口（claude.sunstriker.cc / Tailscale MagicDNS）——它们是完全不同的
  // 域，一个 passkey 覆盖不了两边。登录时按当前 origin 的 rpID 过滤可用凭据，
  // 用户在哪个域用就在哪个域注册一个。
  // counter 是签名计数器，用于克隆检测（回退即可疑）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      cred_id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      rp_id TEXT NOT NULL,
      transports TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      last_used_at TEXT
    )
  `);
}
