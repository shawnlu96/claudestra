/** Peer 面板「中继」卡（features/chat/components/peers-relay-card.tsx）的英文：一键接入、自建说明、官方中继能看到隧道内容的提示 */
export const RELAY_DICT: Record<string, string> = {
  "出门访问目前要靠 Tailscale。接入中继之后，手机不装任何东西就能打开这台机器。":
    "Remote access currently needs Tailscale. Once the relay is on, phones can open this machine with nothing installed.",
  "一键接入官方中继": "Connect to the official relay",
  "接入中继失败": "Couldn't connect the relay",
  "自建中继：在 .env 里加这两行、重启 bridge。": "Self-hosted relay: add these two lines to .env and restart the bridge.",
  "官方中继目前能看到经隧道的内容，敏感内容请用自建中继。":
    "The official relay can currently see traffic through the tunnel; use a self-hosted relay for sensitive content.",
};
