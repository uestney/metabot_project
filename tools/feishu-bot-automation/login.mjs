/**
 * Feishu 飞书开放平台登录（保留登录态供后续脚本复用）
 *  - 打开登录页 → 截二维码
 *  - 轮询扫码（5 分钟超时）
 *  - 成功后把浏览器 storageState 落到 state.json
 *
 * 二维码默认落在 screenshots/qr-code.png；如果设置了 OUTPUT_CHAT_ID 环境变量，
 * 会同时把二维码 copy 一份到 /tmp/metabot-outputs/<chatId>/，借助 metabot 的
 * outputs 机制让 Feishu 用户直接收到二维码图片。
 */
import { chromium } from 'playwright';
import { writeFileSync, existsSync, readFileSync, rmSync, readdirSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEMP_DIR    = path.join(__dirname, 'screenshots');
const STATE_FILE  = path.join(__dirname, 'state.json');
const STATUS_FILE = path.join(__dirname, 'login-status.txt');

// 二维码送到飞书指定 chatId 的输出目录（可选）
const OUTPUT_DIR  = process.env.OUTPUT_CHAT_ID
  ? `/tmp/metabot-outputs/${process.env.OUTPUT_CHAT_ID}`
  : null;

/** 把文件 copy 到指定 chatId 的 outputs 目录（先清空目录），让飞书 metabot 推送给用户 */
function sendToUser(srcPath, filename) {
  if (!OUTPUT_DIR) return;  // 没设置 OUTPUT_CHAT_ID 时跳过
  try { mkdirSync(OUTPUT_DIR, { recursive: true }); } catch {}
  try {
    for (const f of readdirSync(OUTPUT_DIR)) {
      rmSync(`${OUTPUT_DIR}/${f}`, { force: true });
    }
  } catch {}
  const data = readFileSync(srcPath);
  writeFileSync(`${OUTPUT_DIR}/${filename}`, data);
}

async function main() {
  writeFileSync(STATUS_FILE, 'waiting');

  // Ensure temp screenshot dir exists
  const { mkdirSync } = await import('fs');
  mkdirSync(TEMP_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });

  // Load existing state if available
  if (existsSync(STATE_FILE)) {
    try {
      const stateData = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
      if (stateData.cookies) {
        await context.addCookies(stateData.cookies);
        console.log('Loaded existing state');
      }
    } catch {}
  }

  const page = await context.newPage();

  console.log('Opening Feishu Open Platform...');
  await page.goto('https://open.feishu.cn/app', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(5000);

  const url = page.url();
  const needsLogin = url.includes('login') || url.includes('passport') || url.includes('accounts');

  if (!needsLogin) {
    console.log('Already logged in!');
    const state = await context.storageState();
    writeFileSync(STATE_FILE, JSON.stringify(state));
    writeFileSync(STATUS_FILE, 'logged_in');
    await browser.close();
    return;
  }

  // Save QR code and send to user
  console.log('Login required. Saving QR code...');
  const qrPath = `${TEMP_DIR}/qr-code.png`;
  await page.screenshot({ path: qrPath });
  sendToUser(qrPath, 'feishu-qr-code.png');
  writeFileSync(STATUS_FILE, 'qr_ready');
  console.log('QR code sent to user. Waiting for scan...');

  // Poll for login success (every 3s, up to 5 minutes)
  for (let i = 0; i < 100; i++) {
    await page.waitForTimeout(3000);
    const currentUrl = page.url();

    if (!currentUrl.includes('login') && !currentUrl.includes('passport') && !currentUrl.includes('accounts')) {
      console.log(`Login detected after ${(i + 1) * 3}s!`);

      // Wait for page to fully load
      await page.waitForTimeout(8000);

      // Save state
      const state = await context.storageState();
      writeFileSync(STATE_FILE, JSON.stringify(state));
      writeFileSync(STATUS_FILE, 'logged_in');
      console.log('State saved successfully!');

      await browser.close();
      return;
    }

    // Every 30s log progress
    if (i > 0 && i % 10 === 0) {
      console.log(`  Still waiting... (${(i + 1) * 3}s)`);
    }
  }

  console.log('Timeout: no scan in 5 minutes');
  writeFileSync(STATUS_FILE, 'timeout');
  await browser.close();
}

main().catch(e => {
  console.error(e);
  writeFileSync(STATUS_FILE, `error: ${e.message}`);
  process.exit(1);
});
