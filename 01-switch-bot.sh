#!/usr/bin/env bash
# ============================================================================
# 01-switch-bot.sh — 切换 MetaBot 机器人的工作目录和 Session
#
# 用法:
#   ./01-switch-bot.sh <botName> <workDir> [sessionId]
#
# 示例:
#   ./01-switch-bot.sh NP /vepfs/users/ameng/workspace/ytb-video-downloader a1528f93-010e-4511-a16b-12d183964b88
#   ./01-switch-bot.sh SF /vepfs/users/ameng/workspace/dream-factory
#
# 步骤:
#   1. 验证参数（bot 名称、目标目录是否存在）
#   2. 修改 bots.json 中对应 bot 的 defaultWorkingDirectory
#   3. 清空 sessions-<bot>.json 和 sessions.db
#   4. 如有 sessionId，从 ~/.claude/projects/ 提取最近对话写入 pending-switch.json
#   5. pm2 delete + pm2 start ecosystem.config.cjs --only <bot>
#   6. 验证启动日志
# ============================================================================

set -euo pipefail

# ── 颜色 ──────────────────────────────────────────────────────────────────────
RED='\033[91m'
GREEN='\033[92m'
YELLOW='\033[93m'
CYAN='\033[96m'
RESET='\033[0m'

info()  { echo -e "${CYAN}[INFO ]${RESET} $*"; }
ok()    { echo -e "${GREEN}[  OK ]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[WARN ]${RESET} $*"; }
fail()  { echo -e "${RED}[ERROR]${RESET} $*"; exit 1; }

# ── 参数解析 ──────────────────────────────────────────────────────────────────
BOT_NAME="${1:-}"
WORK_DIR="${2:-}"
SESSION_ID="${3:-}"

if [[ -z "$BOT_NAME" || -z "$WORK_DIR" ]]; then
  echo "用法: $0 <botName> <workDir> [sessionId]"
  echo ""
  echo "  botName    - PM2 中的 bot 名称 (如 NP, SF, SA, PA, invoker, ...)"
  echo "  workDir    - 目标工作目录的绝对路径"
  echo "  sessionId  - (可选) Claude session ID，用于恢复上下文"
  exit 1
fi

# ── 常量 ──────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOTS_JSON="$SCRIPT_DIR/bots.json"
ECOSYSTEM="$SCRIPT_DIR/ecosystem.config.cjs"
DATA_DIR="$HOME/.metabot/$BOT_NAME"
SESSIONS_JSON="$DATA_DIR/sessions-${BOT_NAME}.json"
SESSIONS_DB="$DATA_DIR/sessions.db"
PENDING_SWITCH="$DATA_DIR/pending-switch.json"

# ── 前置检查 ──────────────────────────────────────────────────────────────────
[[ -f "$BOTS_JSON" ]]  || fail "bots.json 不存在: $BOTS_JSON"
[[ -f "$ECOSYSTEM" ]]  || fail "ecosystem.config.cjs 不存在: $ECOSYSTEM"
[[ -d "$WORK_DIR" ]]   || fail "目标工作目录不存在: $WORK_DIR"
[[ -d "$DATA_DIR" ]]   || fail "Bot 数据目录不存在: $DATA_DIR (bot 名称是否正确?)"

# 验证 bot 名称在 bots.json 中存在
BOT_EXISTS=$(python3 -c "
import json, sys
with open('$BOTS_JSON') as f:
    data = json.load(f)
found = any(b['name'] == '$BOT_NAME' for b in data['feishuBots'])
print('yes' if found else 'no')
")
[[ "$BOT_EXISTS" == "yes" ]] || fail "Bot '$BOT_NAME' 在 bots.json 中不存在"

info "切换 bot: ${CYAN}$BOT_NAME${RESET}"
info "目标目录: $WORK_DIR"
[[ -n "$SESSION_ID" ]] && info "Session:  $SESSION_ID"
echo ""

# ── Step 1: 修改 bots.json ───────────────────────────────────────────────────
info "Step 1/5: 更新 bots.json ..."
python3 -c "
import json
with open('$BOTS_JSON', 'r') as f:
    data = json.load(f)
for bot in data['feishuBots']:
    if bot['name'] == '$BOT_NAME':
        bot['defaultWorkingDirectory'] = '$WORK_DIR'
        break
with open('$BOTS_JSON', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
"
ok "bots.json 已更新"

# ── Step 2: 清空 session 存储 ────────────────────────────────────────────────
info "Step 2/5: 清空 session 存储 ..."
echo '{}' > "$SESSIONS_JSON"
rm -f "$SESSIONS_DB" "${SESSIONS_DB}-shm" "${SESSIONS_DB}-wal"
ok "sessions-${BOT_NAME}.json + sessions.db 已清空"

# ── Step 3: 写入 pending-switch.json ─────────────────────────────────────────
info "Step 3/5: 生成 pending-switch.json ..."

RECENT_HISTORY="[]"
if [[ -n "$SESSION_ID" ]]; then
  # 在 ~/.claude/projects/ 下查找对应的 session 文件
  SESSION_FILE=$(find "$HOME/.claude/projects/" -name "${SESSION_ID}.jsonl" 2>/dev/null | head -1)
  if [[ -n "$SESSION_FILE" ]]; then
    info "  找到 session 文件: $SESSION_FILE"
    RECENT_HISTORY=$(tail -200 "$SESSION_FILE" | python3 -c "
import sys, json

messages = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
    except:
        continue

    if obj.get('type') == 'user' and obj.get('message', {}).get('role') == 'user':
        content = obj['message'].get('content', '')
        if isinstance(content, list):
            content = ' '.join(b.get('text','') for b in content if b.get('type') == 'text')
        if content:
            messages.append({'role': 'user', 'content': content[:500]})

    if obj.get('message', {}).get('role') == 'assistant':
        content = obj['message'].get('content', '')
        if isinstance(content, list):
            content = ' '.join(b.get('text','') for b in content if b.get('type') == 'text')
        if content:
            if messages and messages[-1]['role'] == 'assistant':
                messages[-1]['content'] = content[:500]
            else:
                messages.append({'role': 'assistant', 'content': content[:500]})

recent = messages[-4:]
print(json.dumps(recent, ensure_ascii=False))
")
    info "  提取到 $(echo "$RECENT_HISTORY" | python3 -c "import sys,json;print(len(json.loads(sys.stdin.read())))") 条最近消息"
  else
    warn "  未找到 session 文件，跳过历史提取"
  fi
fi

cat > "$PENDING_SWITCH" << ENDJSON
{
  "workDir": "$WORK_DIR",
  "sessionId": $(if [[ -n "$SESSION_ID" ]]; then echo "\"$SESSION_ID\""; else echo "null"; fi),
  "chatId": null,
  "recentHistory": $RECENT_HISTORY,
  "timestamp": $(date +%s)000
}
ENDJSON
ok "pending-switch.json 已生成"

# ── Step 4: PM2 重启 ─────────────────────────────────────────────────────────
info "Step 4/5: PM2 重启 $BOT_NAME ..."
pm2 delete "$BOT_NAME" 2>/dev/null || true
pm2 start "$ECOSYSTEM" --only "$BOT_NAME" --silent
ok "PM2 已重启"

# ── Step 5: 验证启动 ─────────────────────────────────────────────────────────
info "Step 5/5: 等待启动并验证 ..."
sleep 3

# 检查进程是否存活
PM2_STATUS=$(pm2 jlist 2>/dev/null | python3 -c "
import sys, json
procs = json.loads(sys.stdin.read())
for p in procs:
    if p['name'] == '$BOT_NAME':
        print(p['pm2_env']['status'])
        break
else:
    print('not_found')
")

if [[ "$PM2_STATUS" == "online" ]]; then
  ok "Bot $BOT_NAME 已上线"
else
  fail "Bot $BOT_NAME 启动失败 (status: $PM2_STATUS)，请检查: pm2 logs $BOT_NAME --lines 30"
fi

# 检查日志中的工作目录
LOGGED_DIR=$(pm2 logs "$BOT_NAME" --lines 20 --nostream 2>&1 | grep -o "defaultWorkingDirectory: .*" | tail -1 | sed 's/defaultWorkingDirectory: //' | tr -d '"' || true)
if [[ "$LOGGED_DIR" == "$WORK_DIR" ]]; then
  ok "工作目录验证通过: $LOGGED_DIR"
elif [[ -n "$LOGGED_DIR" ]]; then
  warn "工作目录不匹配! 期望: $WORK_DIR, 实际: $LOGGED_DIR"
else
  warn "无法从日志中验证工作目录（可能还在启动中）"
fi

echo ""
echo -e "${GREEN}========================================${RESET}"
echo -e "${GREEN}  切换完成!${RESET}"
echo -e "${GREEN}  Bot:     $BOT_NAME${RESET}"
echo -e "${GREEN}  WorkDir: $WORK_DIR${RESET}"
[[ -n "$SESSION_ID" ]] && echo -e "${GREEN}  Session: ${SESSION_ID:0:8}...${RESET}"
echo -e "${GREEN}========================================${RESET}"
echo ""
echo "给 $BOT_NAME 发一条消息即可看到切换通知卡片。"
