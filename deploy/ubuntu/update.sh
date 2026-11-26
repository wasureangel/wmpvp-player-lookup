#!/usr/bin/env bash
set -euo pipefail
site=/opt/wmpvp-multi-eaed139
unit=wmpvp-multi-eaed139.service
script=$(cd "$(dirname "$0")" && pwd)/release.mjs
action=${1:-install}
[[ $EUID == 0 ]] || { echo '请使用 sudo 或 root 运行'; exit 1; }
[[ "$(systemctl show -p WorkingDirectory --value "$unit")" == "$site" ]] || { echo '服务工作目录不匹配'; exit 1; }
exec 9>/run/lock/wmpvp-multi-update.lock
flock -n 9 || { echo '另一次更新正在进行'; exit 1; }
cd "$site"
pid=$(systemctl show -p MainPID --value "$unit")
nodebin=$(readlink -f "/proc/$pid/exe" || true)
[[ -x "$nodebin" ]] || nodebin=$(command -v node)
if [[ "$action" == rollback ]]; then
  [[ -s .query-releases/active ]] || { echo '没有可以回滚的版本'; exit 1; }
  systemctl stop "$unit"
  "$nodebin" "$script" restore "$site"
  systemctl start "$unit"
  systemctl is-active "$unit"
  exit
fi
[[ "$action" == install ]] || { echo '用法: update.sh install|rollback'; exit 1; }
systemctl is-active --quiet "$unit"
"$nodebin" -e "const [a,b]=process.versions.node.split('.').map(Number);if(a<22||(a===22&&b<13))process.exit(1);require('node:sqlite')" || { echo '此服务需要 Node.js 22.13 或以上版本'; exit 1; }
id=$("$nodebin" "$script" prepare "$site")
user=$(systemctl show -p User --value "$unit")
if [[ ! -d .lookup-cache ]]; then install -d -m 700 -o "${user:-root}" .lookup-cache; fi
runuser -u "${user:-root}" -- test -w "$site/.lookup-cache"
# Compare the actual served JS to the on-disk bundle, both before and after switching.
probe() { curl --noproxy '*' -fsS --max-time 3 http://127.0.0.1:18766/app.js | cmp -s - dist/app.js; }
probe || { echo '18766 返回的 app.js 与部署目录不同，原服务继续运行'; exit 1; }
recover() {
  trap - ERR HUP INT TERM
  set +e
  systemctl stop "$unit"
  if [[ "$(cat .query-releases/active 2>/dev/null)" == "$id" ]]; then
    "$nodebin" "$script" restore "$site" || { echo '恢复失败，请检查 .query-releases'; exit 1; }
  fi
  systemctl start "$unit"
  echo '升级中断，已尝试重新启动原版本'
  exit 1
}
trap recover ERR HUP INT TERM
systemctl stop "$unit"
"$nodebin" "$script" activate "$site" "$id"
systemctl start "$unit"
for _ in {1..12}; do
  if systemctl is-active --quiet "$unit" && probe; then
    trap - ERR HUP INT TERM
    echo "升级完成，备份记录 $id"
    exit 0
  fi
  sleep 1
done
recover
