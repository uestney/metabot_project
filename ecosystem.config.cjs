/**
 * MetaBot 多进程 PM2 配置
 *
 * 架构：每个 bot 独立一个 Node.js 进程，互不共享状态。
 * - 通过 BOT_NAME 环境变量让 src/config.ts 把 bots.json 过滤成单 bot
 * - 每个 bot 有独立的 API/Memory 端口、独立的 ~/.metabot/<name>/ 数据目录
 * - 重启某个 bot：`pm2 restart <bot-name>`
 *
 * Bot 列表从 bots.json 自动读取，端口按顺序自动分配：
 *   第 1 个 bot  API <BASE>,     Memory <BASE+10>
 *   第 2 个 bot  API <BASE+1>,   Memory <BASE+11>
 *   ...
 *
 * 端口基准可通过 .env 中 API_PORT_BASE 配置（默认 10001）。
 */
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const ROOT     = __dirname;
const HOME     = os.homedir();
const LOGS_DIR = path.join(ROOT, 'logs');

// ── 从 bots.json 读取 bot 列表 ──────────────────────────────────────────────
const BOTS_CONFIG_PATH = path.join(ROOT, 'bots.json');
let bots = [];
try {
  const data = JSON.parse(fs.readFileSync(BOTS_CONFIG_PATH, 'utf-8'));
  bots = (data.feishuBots || []);
} catch (err) {
  console.error(`[ecosystem] Failed to read ${BOTS_CONFIG_PATH}: ${err.message}`);
  process.exit(1);
}

// ── 端口基准（可通过 .env 覆盖） ────────────────────────────────────────────
let apiPortBase = 10001;
try {
  const envFile = fs.readFileSync(path.join(ROOT, '.env'), 'utf-8');
  const match   = envFile.match(/^API_PORT_BASE\s*=\s*(\d+)/m);
  if (match) apiPortBase = parseInt(match[1], 10);
} catch { /* .env 不存在也没关系 */ }

// ── 生成 PM2 app 配置 ───────────────────────────────────────────────────────
function makeApp(bot, index) {
  const { name } = bot;
  const apiPort    = apiPortBase + index * 3;
  const memoryPort = apiPortBase + index * 3 + 1;
  const dataRoot   = path.join(HOME, '.metabot', name);

  // Per-bot env injection (`env: { ... }` in bots.json) — same pattern as
  // Codex's `codex.env`. Lets a bot use a third-party Anthropic-compatible
  // proxy by setting ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY.
  // Auto-injects METABOT_PREFER_ENV_AUTH=true when an Anthropic auth env is
  // present, so the executor bypasses its default filter that strips these
  // vars when ~/.claude/.credentials.json exists. User does not have to set
  // the flag manually.
  const customEnv = bot.env || {};
  const hasAnthropicAuth = !!(customEnv.ANTHROPIC_AUTH_TOKEN || customEnv.ANTHROPIC_API_KEY);
  const autoFlags = hasAnthropicAuth ? { METABOT_PREFER_ENV_AUTH: 'true' } : {};

  return {
    name,
    script:           'src/index.ts',
    // Use `node --import tsx` (tsx 4.x cross-platform entrypoint) instead of
    // the tsx wrapper script — wrapper is a POSIX shell script with no .cmd
    // shim, which PM2 can't spawn on Windows. Backport from upstream PR #245.
    interpreter:      'node',
    interpreter_args: '--import tsx',
    cwd:              ROOT,

    watch: false,

    autorestart:   true,
    max_restarts:  10,
    min_uptime:    '10s',
    restart_delay: 3000,

    error_file: path.join(LOGS_DIR, `${name}-error.log`),
    out_file:   path.join(LOGS_DIR, `${name}-out.log`),
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',

    env: {
      NODE_ENV:            'production',
      BOTS_CONFIG:         'bots.json',
      BOT_NAME:            name,
      API_PORT:            String(apiPort),
      MEMORY_PORT:         String(memoryPort),
      METABOT_DATA_DIR:    dataRoot,
      MEMORY_DATABASE_DIR: path.join(dataRoot, 'data'),
      META_MEMORY_URL:     `http://localhost:${memoryPort}`,
      CLAUDE_MAX_TURNS:    '',
      CARD_SCHEMA_V2:      'true',
      ...customEnv,
      ...autoFlags,
    },
  };
}

module.exports = {
  apps: bots.map((bot, i) => makeApp(bot, i)),
};
