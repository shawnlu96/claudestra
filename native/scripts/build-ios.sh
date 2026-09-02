#!/bin/bash
# 在装有 Xcode 的机器上跑:编译 Debug 包并无线装到已配对的 iPhone。
#   TEAM_ID       默认 G3TUSL5X84
#   PROFILE_FILE  手工签名用的 .mobileprovision(默认取 Xcode 缓存里团队的通配开发文件)
#   DEVICE_ID     devicectl 的 Identifier,缺省取第一台已配对设备
#   DEVELOPER_DIR 未 xcode-select 时自动指向 /Applications/Xcode*.app
# 签名策略:先试 Xcode 自动签名(离线,复用本机缓存的托管描述文件,不联网);
# 失败则产出未签名 .app,用钥匙串里的开发证书 + 描述文件手工 codesign——
# 不依赖 Xcode 里的 Apple ID 会话(账号不是本机主人的,登录会话过期就没法自动签)。
set -euo pipefail
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-$(ls -d /Applications/Xcode*.app | head -1)/Contents/Developer}"
TEAM="${TEAM_ID:-G3TUSL5X84}"
BUNDLE_ID="com.claudestra.app"
DERIVED="build/DerivedData"
mkdir -p build
if [ -z "${DEVICE_ID:-}" ]; then
  xcrun devicectl list devices --json-output "$PWD/build/devices.json" >/dev/null
  DEVICE_ID=$(python3 -c "import json;d=json.load(open('build/devices.json'));print(next(x['identifier'] for x in d['result']['devices'] if x.get('connectionProperties',{}).get('pairingState')=='paired'))")
fi
if [ -z "${PROFILE_FILE:-}" ]; then
  for f in ~/Library/Developer/Xcode/UserData/Provisioning\ Profiles/*.mobileprovision ~/Library/MobileDevice/Provisioning\ Profiles/*.mobileprovision; do
    [ -f "$f" ] || continue
    if security cms -D -i "$f" 2>/dev/null | grep -q "<string>$TEAM.\*</string>"; then PROFILE_FILE="$f"; break; fi
  done
fi
echo "▶ device=$DEVICE_ID team=$TEAM profile=${PROFILE_FILE:-<none>}"

# pbxproj:App target 自动签名 + 团队(只有 App target 有 CODE_SIGN_STYLE;Pods 在另一工程)
PBX=ios/App/App.xcodeproj/project.pbxproj
TEAM="$TEAM" python3 - "$PBX" <<'PY'
import os, re, sys
p = sys.argv[1]; s = open(p).read(); team = os.environ["TEAM"]
s = re.sub(r'CODE_SIGN_STYLE = Manual;', 'CODE_SIGN_STYLE = Automatic;', s)
s = re.sub(r'PROVISIONING_PROFILE_SPECIFIER = "[^"]*";\n\s*', '', s)
s = re.sub(r'CODE_SIGN_IDENTITY = "[^"]*";\n\s*', '', s)
s = re.sub(r'DEVELOPMENT_TEAM = "?[A-Z0-9]*"?;', f'DEVELOPMENT_TEAM = {team};', s)
if 'DEVELOPMENT_TEAM' not in s:
    s = re.sub(r'(CODE_SIGN_STYLE = Automatic;\n(\s*))', lambda m: f'{m.group(1)}DEVELOPMENT_TEAM = {team};\n{m.group(2)}', s)
open(p, "w").write(s)
PY

if [ -d ios/App/App.xcworkspace ]; then SRC=(-workspace ios/App/App.xcworkspace); else SRC=(-project ios/App/App.xcodeproj); fi
PRODUCTS="$DERIVED/Build/Products/Debug-iphoneos"
rm -rf "$PRODUCTS"

echo "▶ 1/2 自动签名(离线)"
if xcodebuild "${SRC[@]}" -scheme App -configuration Debug -destination "generic/platform=iOS" \
     -derivedDataPath "$DERIVED" build > build/xcodebuild-auto.log 2>&1; then
  echo "  ✓ 自动签名成功"
else
  grep -E "error:" build/xcodebuild-auto.log | head -3 | sed 's/^/  /'
  echo "▶ 2/2 未签名构建 + 手工 codesign"
  [ -n "${PROFILE_FILE:-}" ] || { echo "✗ 没有可用描述文件"; exit 1; }
  xcodebuild "${SRC[@]}" -scheme App -configuration Debug -destination "generic/platform=iOS" \
    -derivedDataPath "$DERIVED" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
    build > build/xcodebuild-unsigned.log 2>&1 || { grep -E "error:" build/xcodebuild-unsigned.log | head -5; exit 1; }
  APP=$(find "$PRODUCTS" -maxdepth 1 -name "*.app" | head -1)
  IDENTITY=$(security find-identity -v -p codesigning | grep "Apple Development" | head -1 | sed -E 's/.*"(.*)".*/\1/')
  echo "  identity=$IDENTITY"
  cp "$PROFILE_FILE" "$APP/embedded.mobileprovision"
  cat > build/entitlements.plist <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>application-identifier</key><string>$TEAM.$BUNDLE_ID</string>
  <key>com.apple.developer.team-identifier</key><string>$TEAM</string>
  <key>get-task-allow</key><true/>
  <key>keychain-access-groups</key><array><string>$TEAM.*</string></array>
</dict></plist>
PL
  # 先签内嵌 framework / dylib,再签主包
  find "$APP/Frameworks" -maxdepth 1 \( -name "*.framework" -o -name "*.dylib" \) 2>/dev/null | while read -r fw; do
    codesign --force --sign "$IDENTITY" --timestamp=none "$fw" >/dev/null
  done
  codesign --force --sign "$IDENTITY" --timestamp=none --entitlements build/entitlements.plist "$APP"
  codesign --verify --deep --strict "$APP" && echo "  ✓ 手工签名通过"
fi
APP=$(find "$PRODUCTS" -maxdepth 1 -name "*.app" | head -1)
[ -n "$APP" ] || { echo "✗ 没有产出 .app"; exit 1; }
echo "▶ install $APP"
xcrun devicectl device install app --device "$DEVICE_ID" "$APP" 2>&1 | tail -3
xcrun devicectl device process launch --device "$DEVICE_ID" "$BUNDLE_ID" 2>&1 | tail -1 || true
echo "✓ 已装到手机并拉起"
