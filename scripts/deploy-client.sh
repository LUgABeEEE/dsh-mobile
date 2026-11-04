#!/usr/bin/env bash
# deploy-client.sh —— 把本仓库构建出的 client bundle 部署到**运行中的网关插件目录**
#
# ⚠️ 这会改运行中的网关：脚本默认只做「检查 + 备份 + 演练」，真正复制需要 --apply。
#    部署后要重载 App 页面（或重启网关）才生效；回滚命令会被打印并写入回滚凭证文件。
#
# 用法：
#   scripts/deploy-client.sh                 # 只检查环境 + 打印计划（不改任何文件）
#   scripts/deploy-client.sh --apply         # 备份 → 复制 → 打印重载/回滚命令
#   scripts/deploy-client.sh --apply --restart   # 复制后再重启网关（需自行确认重启方式）
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${DSH_MOBILE_PLUGIN_DIR:-$HOME/.dsh/profiles/web/node_modules/dsh-mobile}"
SOURCE="$REPO/lib/client.js"
APPLY=0
RESTART=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --restart) RESTART=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '✘ %s\n' "$*" >&2; exit 1; }

say "1) 目标"
echo "  仓库     $REPO"
echo "  源文件   $SOURCE"
echo "  目标目录 $TARGET_DIR"

[ -f "$SOURCE" ] || die "源文件不存在：$SOURCE（先跑 npm run build）"

# 构建新鲜度：src/ 里有比 lib/client.js 更新的文件，说明忘了 npm run build
STALE="$(find "$REPO/src" -newer "$SOURCE" -name '*.ts' 2>/dev/null | head -3)"
if [ -n "$STALE" ]; then
  printf '⚠️  lib/client.js 比这些源文件旧，先 npm run build：\n' >&2
  printf '%s\n' "$STALE" | sed 's/^/     /' >&2
  [ "${ALLOW_STALE:-0}" = "1" ] || die "拒绝部署过期构建（确要部署请设 ALLOW_STALE=1）"
fi
TARGET="$TARGET_DIR/lib/client.js"
[ -f "$TARGET" ] || die "目标不存在：$TARGET（插件未安装到该 profile？可用 DSH_MOBILE_PLUGIN_DIR 指定）"

SRC_SUM="$(sha256sum "$SOURCE" | awk '{print $1}')"
DST_SUM="$(sha256sum "$TARGET" | awk '{print $1}')"
SRC_SIZE="$(stat -c %s "$SOURCE")"
DST_SIZE="$(stat -c %s "$TARGET")"

say "2) 现状"
echo "  源   $SRC_SUM  ${SRC_SIZE} B"
echo "  目标 $DST_SUM  ${DST_SIZE} B"
[ "$SRC_SUM" = "$DST_SUM" ] && echo "  → 已经一致，无需部署" && exit 0

BACKUP="$TARGET.bak-$(date +%Y%m%d-%H%M%S)"
ROLLBACK_FILE="$REPO/.deploy-rollback-$(date +%Y%m%d-%H%M%S).txt"

if [ "$APPLY" != "1" ]; then
  say "3) 计划（未执行；加 --apply 才真正复制）"
  echo "  cp -a \"$TARGET\" \"$BACKUP\""
  echo "  cp -a \"$SOURCE\" \"$TARGET\""
  echo "  重载：从最近任务划掉 DSH App 再打开（或重启网关进程）"
  exit 0
fi

say "3) 备份原文件"
cp -a "$TARGET" "$BACKUP" || die "备份失败（权限？）"
echo "  备份 → $BACKUP"
echo "  备份 sha256 校验：$(sha256sum "$BACKUP" | awk '{print $1}')（应等于 $DST_SUM）"

say "4) 复制构建产物"
cp -a "$SOURCE" "$TARGET" || die "复制失败"
NOW_SUM="$(sha256sum "$TARGET" | awk '{print $1}')"
[ "$NOW_SUM" = "$SRC_SUM" ] || die "复制后校验不一致：$NOW_SUM != $SRC_SUM"
echo "  已复制，sha256 = $NOW_SUM"

cat > "$ROLLBACK_FILE" <<EOF
# droidv-mobile client 部署凭证 $(date -Iseconds)
target=$TARGET
backup=$BACKUP
before_sha256=$DST_SUM
after_sha256=$SRC_SUM
# 回滚：
#   cp -a "$BACKUP" "$TARGET"
#   然后重载 App 页面
EOF

say "5) 生效与回滚"
echo "  生效：从最近任务划掉 DSH App 再打开（客户端 bundle 由网关下发，重载页面即生效）"
echo "  回滚：cp -a \"$BACKUP\" \"$TARGET\"    # 凭证：$ROLLBACK_FILE"
[ "$RESTART" = "1" ] && echo "  --restart 已指定：请按你们的网关重启方式执行（脚本不猜进程管理）"

say "完成"
