import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 截图输出位置：默认放当前目录的 screenshots/，可通过 OUTPUT_DIR env 覆盖
const SD = process.env.OUTPUT_DIR || path.join(__dirname, 'screenshots');
mkdirSync(SD, { recursive: true });

// 浏览器会话状态文件（保存登录态以避免每次都扫码）
const STATE_FILE = path.join(__dirname, 'browser-state.json');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  console.log('Opening login page...');
  await page.goto('https://open.feishu.cn/app', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${SD}/qr-code-scan-me.png` });

  const url = page.url();
  console.log(`URL: ${url}`);

  if (url.includes('login') || url.includes('accounts')) {
    console.log('QR code screenshot saved. Please scan it.');
    // Save browser storage state so we can resume
    const storageState = await context.storageState();
    writeFileSync(STATE_FILE, JSON.stringify(storageState));
    console.log('Browser state saved.');
  } else {
    console.log('Already logged in!');
  }

  // Keep browser open is not possible in script mode.
  // We'll need to save the state and use a polling approach.
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
