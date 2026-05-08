/**
 * 共享工具：从项目根的 bots.json 读取 bot 配置（去敏版）
 * 所有脚本都通过这里拿 App ID，不再硬编码任何 Secret
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const BOTS_JSON_PATH = path.resolve(__dirname, '..', '..', 'bots.json');

function loadConfig() {
  try {
    return JSON.parse(readFileSync(BOTS_JSON_PATH, 'utf8'));
  } catch (e) {
    console.error(`无法读取 ${BOTS_JSON_PATH}: ${e.message}`);
    console.error('确认 bots.json 存在于项目根目录');
    process.exit(1);
  }
}

/** name -> appId 映射，例如 { SF: 'cli_xxx', PA: 'cli_yyy', ... } */
export function loadBotsAppIds() {
  const config = loadConfig();
  return Object.fromEntries(config.feishuBots.map(b => [b.name, b.feishuAppId]));
}

/** 完整 bot 列表（含 secret），需要 secret 时用 */
export function loadBotsWithSecrets() {
  return loadConfig().feishuBots;
}

/** Playwright 浏览器持久化状态文件（每个开发者本地，已 gitignored）*/
export const STATE_FILE = path.resolve(__dirname, 'state.json');

/** 截图输出目录（已 gitignored）*/
export const SCREENSHOTS_DIR = path.resolve(__dirname, 'screenshots');
