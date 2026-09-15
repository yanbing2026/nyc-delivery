#!/bin/sh
# 重启演示服务：run.sh [端口]（默认 8899）
# 用 PID 文件记进程：这台 PRoot 上 ss -lntp 拿不到 pid，靠端口反查会静默失败，
# 结果旧进程占着端口、新进程 bind 失败，健康检查还照样通过（配置改了却没生效）。
PORT="${1:-8899}"
cd "$(dirname "$0")" || exit 1
PIDFILE="/tmp/wxmenu-$PORT.pid"

stop_old() {
  if [ -f "$PIDFILE" ]; then
    PID=$(cat "$PIDFILE")
    if kill -0 "$PID" 2>/dev/null; then kill "$PID" && echo "已停止旧进程 $PID"; sleep 0.8; fi
    rm -f "$PIDFILE"
  fi
}

stop_old

# 兜底：PID 文件丢了就按命令行找（不用 pkill -f，那个会把当前这条命令自己也匹配掉）
for p in $(pgrep -f "python3 server\.py $PORT" 2>/dev/null); do
  [ "$p" != "$$" ] && kill "$p" 2>/dev/null && echo "已停止残留进程 $p"
done
sleep 0.4

nohup python3 server.py "$PORT" >"/tmp/wxmenu-$PORT.log" 2>&1 &
NEW=$!
echo "$NEW" >"$PIDFILE"
sleep 1.8

if ! kill -0 "$NEW" 2>/dev/null; then
  echo "❌ 新进程启动失败（端口可能被占），日志尾部："
  tail -5 "/tmp/wxmenu-$PORT.log"
  exit 1
fi
if curl -s -m 3 -o /dev/null "http://127.0.0.1:$PORT/api/state"; then
  echo "已启动（pid $NEW）：控制台 http://127.0.0.1:$PORT/  点单页 http://127.0.0.1:$PORT/order"
else
  echo "❌ 进程活着但接口不通，看 /tmp/wxmenu-$PORT.log"; tail -5 "/tmp/wxmenu-$PORT.log"; exit 1
fi
