/**
 * MetaBot 多进程 PM2 配置
 *
 * 架构：每个 bot 独立一个 Node.js 进程，互不共享状态。
 * - 通过 BOT_NAME 环境变量让 src/config.ts 把 bots.json 过滤成单 bot
 * - 每个 bot 有独立的 API/Memory 端口、独立的 ~/.metabot/<name>/ 数据目录
 * - 重启某个 bot：`pm2 restart <bot-name>`
 *
 * 端口分配（invoker 是基准 10001，其他依次 +1）：
 *   invoker     API 10001, Memory 10011
 *   nec-bot     API 10002, Memory 10012
 *   windranger  API 10003, Memory 10013
 *   SF          API 10004, Memory 10014
 *   PA          API 10005, Memory 10015
 *   SA          API 10006, Memory 10016
 *   NP          API 10007, Memory 10017
 */
const path = require('path');
const os   = require('os');

const ROOT     = __dirname;
const TSX      = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const HOME     = os.homedir();
const LOGS_DIR = path.join(ROOT, 'logs');

/**
 * bot 列表 + 端口分配（invoker 在前作为基准）
 * 修改这里就能调整 bot 顺序 / 端口范围 / 增删 bot
 */
const BOTS = [
  { name: 'invoker',    apiPort: 10001, memoryPort: 10011 },
  { name: 'nec-bot',    apiPort: 10002, memoryPort: 10012 },
  { name: 'windranger', apiPort: 10003, memoryPort: 10013 },
  { name: 'SF',         apiPort: 10004, memoryPort: 10014 },
  { name: 'PA',         apiPort: 10005, memoryPort: 10015 },
  { name: 'SA',         apiPort: 10006, memoryPort: 10016 },
  { name: 'NP',         apiPort: 10007, memoryPort: 10017 },
];

function makeApp(bot) {
  const dataRoot = path.join(HOME, '.metabot', bot.name);
  return {
    name:        bot.name,
    script:      'src/index.ts',
    interpreter: TSX,
    cwd:         ROOT,

    // 配置代码改动后用 `metabot restart` 手动应用
    watch: false,

    autorestart:   true,
    max_restarts:  10,
    min_uptime:    '10s',
    restart_delay: 3000,

    error_file: path.join(LOGS_DIR, `${bot.name}-error.log`),
    out_file:   path.join(LOGS_DIR, `${bot.name}-out.log`),
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',

    env: {
      NODE_ENV:            'production',
      BOTS_CONFIG:         'bots.json',
      BOT_NAME:            bot.name,
      API_PORT:            String(bot.apiPort),
      MEMORY_PORT:         String(bot.memoryPort),
      // 单 bot 进程私有数据目录，所有 db / json 落到这里
      METABOT_DATA_DIR:    dataRoot,
      // MetaMemory 的 SQLite 也放进 bot 私有目录（避免共享 ./data 写冲突）
      MEMORY_DATABASE_DIR: path.join(dataRoot, 'data'),
      // metamemory 客户端要查的服务端 URL（指向自己进程的 memory port）
      META_MEMORY_URL:     `http://localhost:${bot.memoryPort}`,
      // 不限制 turn 数（沿用旧 metabot 配置）
      CLAUDE_MAX_TURNS:    '',
      // 卡片 schema：v2 全员启用（PA 灰度通过后切换全部）
      CARD_SCHEMA_V2: 'true',
    },
  };
}

module.exports = {
  apps: BOTS.map(makeApp),
};
