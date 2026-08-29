#!/bin/sh
# dsh-daemon 容器入口（PID 1）
#
# 为什么不能直接 CMD ["node", "watchdog.js"]：
#   watchdog 是"监控 + 重启 web"的角色；若它是 PID 1，`dsh-daemon restart`
#   或自动更新触发的自身退出会让 PID 1 退出 → 整个容器停止。
# 这里 PID 1 是一个 supervisor：watchdog 作为子进程运行，退出/崩溃时自动拉起，
# 等价于 launchd KeepAlive 在容器里的角色。
#
# 容器停止（docker stop）时：SIGTERM 发给 PID 1 → 转发给 watchdog 优雅退出。

set -u

DSH_HOME="${DSH_HOME:-/root/.dsh}"
WATCHDOG="$DSH_HOME/daemon/watchdog.js"
LOG="$DSH_HOME/daemon/logs/watchdog.log"

# 日志目录可能不存在（空卷恢复前 / 首次启动）：先建目录，log() 才能 tee。
ensure_log_dir() { mkdir -p "$(dirname "$LOG")"; }
ensure_log_dir

log() { echo "[$(date -u +%FT%TZ)] [supervisor] $*" | tee -a "$LOG"; }

# ---- 卷为空自动恢复 -----------------------------------------------
# 场景：docker-compose 把 ./data/dsh-home 挂到 /root/.dsh；首次挂载时宿主机目录
# 是空的，会覆盖镜像构建期生成的 DSH_HOME → watchdog.js 不存在。
# 这里检测缺失并从镜像预置快照 /opt/dsh-preset/dsh-home 恢复初始状态
# （插件 profile + watchdog + CLI + 空凭据/配置骨架）。
# 恢复后由用户/后续步骤填充凭据与配置；已存在的文件绝不被覆盖（幂等）。
PRESET=/opt/dsh-preset/dsh-home

restore_preset() {
  log "DSH_HOME missing or empty — restoring preset from $PRESET ..."
  mkdir -p "$DSH_HOME"
  ensure_log_dir
  # 只复制不存在的部分：cp -n 不覆盖已存在文件；排除运行时瞬态（备份时已清理）
  cp -an "$PRESET"/. "$DSH_HOME"/
  # 权限兜底：关键可执行脚本保持可执行（cp -a 保留原权限，此处保险）
  chmod +x "$DSH_HOME/daemon/watchdog.js" 2>/dev/null || true
  log "preset restored."
}

# 触发条件：watchdog 不存在（目录为空或被清空）→ 恢复预置
if [ ! -f "$WATCHDOG" ]; then
  if [ -d "$PRESET" ]; then
    restore_preset
  else
    log "ERROR: $WATCHDOG not found and no preset at $PRESET. 请确认镜像构建时 install 成功。"
    exit 1
  fi
fi

# 恢复后仍不存在 → 预置本身有问题
if [ ! -f "$WATCHDOG" ]; then
  log "ERROR: preset restore did not produce $WATCHDOG — image is broken."
  exit 1
fi

# 清理卷里可能残留的陈旧 watchdog PID 文件（旧镜像预置 / 异常退出遗留）。
# watchdog 的单实例守卫会读它：若 PID 被容器内其它进程（如上面的 tail -f）
# 复用，守卫误判"已有 watchdog 在跑"→ 直接 exit(0) → supervisor 无限重启。
# Linux 下守卫已改为校验 /proc/<pid>/cmdline（v0.1.21），这里再兜底一次。
rm -f "$DSH_HOME/daemon/.dsh-watchdog.pid"

log "starting watchdog: node $WATCHDOG"

# ---- dsh web 输出流到 docker logs ------------------------------------
# watchdog 把 dsh web 的 stdout/stderr 重定向到 daemon/logs/dsh-web.log；
# 这里用 tail -f 把它转发到本进程的 stdout，`docker logs` 即可看到 web 输出
# （也含 v0.1.19 的 token 授权 URL，方便首次访问）。
WEB_LOG="$DSH_HOME/daemon/logs/dsh-web.log"
touch "$WEB_LOG" 2>/dev/null || true
tail -f -n +1 "$WEB_LOG" 2>/dev/null &
TAIL_PID=$!

# docker stop: 转发 SIGTERM 给 watchdog，等待它优雅退出（写 PID、清标记）。
# 收到 TERM/INT 时不再重启 watchdog。
stop() {
  log "received SIGTERM, stopping watchdog..."
  kill "$TAIL_PID" 2>/dev/null || true
  WATCHDOG_PID="$(cat "$DSH_HOME/daemon/.dsh-watchdog.pid" 2>/dev/null || true)"
  if [ -n "$WATCHDOG_PID" ]; then
    kill -TERM "$WATCHDOG_PID" 2>/dev/null || true
    # 给 watchdog 一点时间写退出状态
    for i in 1 2 3 4 5; do
      kill -0 "$WATCHDOG_PID" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "$WATCHDOG_PID" 2>/dev/null || true
  fi
  exit 0
}
trap stop TERM INT

# 主循环：watchdog 退出（崩溃 / restart 流程自身退出）后自动重启
while true; do
  node "$WATCHDOG"
  code=$?
  log "watchdog exited (code=$code), restarting in 2s..."
  sleep 2
done
