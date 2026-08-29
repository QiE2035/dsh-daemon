# dsh-daemon Docker 镜像
# 预置：dsh CLI + @chenkai114/dsh-daemon 插件 + 已生成的 watchdog（构建期 install）
FROM registry.nevis.sina.com.cn/wbcc/node:lts-trixie-slim

# ---- 基础环境：国内镜像加速 + 工具包 + locale/TZ ----
# Debian trixie 用 deb822 格式的 /etc/apt/sources.list.d/debian.sources，先换国内源
# 注意：官方 docker-clean 的 Post-Invoke 钩子（rm -f /var/cache/apt/...）在部分
# 镜像/构建环境下执行失败会报 "Problem executing scripts APT::Update::Post-Invoke"。
# 直接删除钩子配置源文件（比 -o 命令行覆盖更可靠），并确保 partial 目录存在。
RUN rm -f /etc/apt/apt.conf.d/docker-clean \
 && mkdir -p /var/cache/apt/archives/partial \
 && sed -i -e 's|deb.debian.org|ftp.cn.debian.org|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      curl lsof procps \
      gawk git net-tools wget vim \
      locales tzdata \
 && rm -rf /var/lib/apt/lists/*

# ---- locale：精简镜像默认无 zh_CN.UTF-8，直接 ENV LANG=zh_CN.UTF-8 不生效，
#      必须先生成 locale；TZ 同理装 tzdata 后设 Asia/Shanghai ----
RUN sed -i 's/^# *\(zh_CN.UTF-8 UTF-8\)/\1/' /etc/locale.gen \
 && locale-gen \
 && ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime

ENV TZ=Asia/Shanghai \
    LANG=zh_CN.UTF-8 \
    LC_ALL=zh_CN.UTF-8 \
    DSH_HOME=/root/.dsh \
    DSH_DAEMON_NO_SYSTEM=1 \
    DSH_DAEMON_OPEN_BROWSER=0

# ---- npm 环境：允许必需包的 install scripts + 用 corepack 激活 pnpm（不再 npm i -g pnpm） ----
RUN npm config set allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs --location=user \
 && corepack enable \
 && corepack prepare pnpm@latest --activate

# dsh CLI（pnpm 由 corepack 提供，PATH 上已有 shim）
RUN npm i -g @deepseek-ai/dsh

ARG CACHEBUST=1

# 构建期一次性初始化：
#   1. 安装 dsh-daemon 插件到 web profile（bundle 机制，启动自动挂载）
#   2. 临时起 headless web → 调 /dsh-daemon/command 执行 install → 生成 watchdog.js + CLI
#   产物全部落盘，临时 web 即杀
RUN dsh plugin --profile web add @chenkai114/dsh-daemon@v0.1.21 \
 && (dsh web --port 3080 --no-open > /tmp/dsh-boot.log 2>&1 & echo $! > /tmp/dsh-boot.pid) \
 && for i in $(seq 1 60); do \
      curl -s -X POST http://127.0.0.1:3080/dsh-daemon/command -d '{"cmd":"bogus"}' 2>/dev/null | grep -q unknown && break; \
      sleep 1; \
    done \
 && curl -s -X POST http://127.0.0.1:3080/dsh-daemon/command -d '{"cmd":"install"}' \
 && kill "$(cat /tmp/dsh-boot.pid)" 2>/dev/null || true \
 && sleep 1 \
 && rm -f /tmp/dsh-boot.log /tmp/dsh-boot.pid

# 预置快照：把构建期生成的完整 DSH_HOME 备份到镜像内，供运行时"卷为空"自动恢复。
# 排除运行时瞬态（PID 文件、日志），只留可复用的初始状态。
# 注意：/root/.dsh 里可能有 API key 等凭据（.credentials.yaml）——构建镜像时
# 务必保证 DSH_HOME 是干净的预置状态，或用 ARG/构建期注入真实凭据。
RUN mkdir -p /opt/dsh-preset \
 && cp -a /root/.dsh /opt/dsh-preset/dsh-home \
 && rm -rf /opt/dsh-preset/dsh-home/daemon/logs \
          /opt/dsh-preset/dsh-home/daemon/.dsh-*.pid \
          /opt/dsh-preset/dsh-home/sessions \
          /opt/dsh-preset/dsh-home/cache \
          /opt/dsh-preset/dsh-home/attachments \
          /opt/dsh-preset/dsh-home/.anonymous-user-id \
 && echo "preset size:" && du -sh /opt/dsh-preset/dsh-home

# 容器入口：PID 1 = supervisor，watchdog 是子进程（restart 不会重启容器）
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 3080
ENTRYPOINT ["/docker-entrypoint.sh"]
