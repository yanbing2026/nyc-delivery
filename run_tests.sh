#!/bin/sh
# 一次跑完全部测试。需要：python3、node（含 node:sqlite，Node 22+/24）、联网（调纽约官方地址与路线接口）
# 用法：./run_tests.sh
cd "$(dirname "$0")" || exit 1
FAILED=""
run() {
  name="$1"; dir="$2"; shift 2
  printf '\n\033[1m── %s\033[0m\n' "$name"
  if (cd "$dir" && "$@") > /tmp/nyc-test-out.txt 2>&1; then
    tail -1 /tmp/nyc-test-out.txt | sed 's/^/  /'
    grep -c '✓' /tmp/nyc-test-out.txt | sed 's/^/  通过项数: /'
  else
    echo "  ❌ 失败，最后 15 行："
    tail -15 /tmp/nyc-test-out.txt | sed 's/^/    /'
    FAILED="$FAILED $name"
  fi
}

run "后端 selftest（签名/菜单/小票/字节/HTTP/队列）" backend python3 selftest.py
run "后端里程与配送费（真调 NYC 接口）" backend python3 test_delivery.py
run "后端点单页（DOM 桩 + 真后端）" backend node test-order-page.js
run "前端逻辑（菜单规则 + 小票，与 Python 逐字符比对）" docs node test-wxmenu.js
run "前端里程模块" docs node test-delivery.js
run "Pages 版点单页（浏览器内算里程）" docs node test-order-page-static.js
run "Worker + D1 全链路（真实 SQL）" worker node test_worker.mjs

printf '\n'
if [ -n "$FAILED" ]; then
  printf '\033[31m❌ 有失败：%s\033[0m\n' "$FAILED"
  exit 1
fi
printf '\033[32m✅ 全部通过\033[0m\n'
