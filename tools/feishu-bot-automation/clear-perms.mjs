/**
 * clear-perms.mjs - 清空指定 bot 的所有权限（点每行的"关闭"链接）
 * 用法: node clear-perms.mjs <BOT_NAME>
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { loadBotsAppIds, STATE_FILE } from './_lib.mjs';

const BOTS = loadBotsAppIds();

const arg = process.argv[2];
const appId = BOTS[arg];
if (!appId) {
  console.error(`用法: node clear-perms.mjs <${Object.keys(BOTS).join('|')}>`);
  process.exit(1);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(m) { console.log(`[${new Date().toISOString().slice(11,19)}] ${m}`); }

async function gotoPermPage(page, appId) {
  await page.goto(`https://open.feishu.cn/app/${appId}`, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(5000);
  await page.locator('text=权限管理').first().click();
  await sleep(7000);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    storageState: STATE_FILE,
  });
  const page = await context.newPage();

  await page.goto('https://open.feishu.cn/app', { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(5000);
  if (page.url().includes('login')) { log('SESSION EXPIRED'); process.exit(1); }
  log('login OK');

  await gotoPermPage(page, appId);

  let removed = 0;
  for (let iter = 0; iter < 30; iter++) {
    // 找页面上所有"关闭"链接（位于已开通权限表格内）
    const closeLinks = page.locator('a:has-text("关闭"), button:has-text("关闭")');
    const cnt = await closeLinks.count();
    log(`iter ${iter}: 找到 ${cnt} 个"关闭"链接`);
    if (cnt === 0) break;

    try {
      await closeLinks.first().click();
      await sleep(2500);
      // 处理确认对话框
      const confirmBtn = page.locator('[role="dialog"] button:has-text("确认"), [role="dialog"] button:has-text("确定"), [role="dialog"] button:has-text("关闭")').last();
      if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await confirmBtn.click();
        await sleep(4000);
      }
      removed++;
    } catch (e) {
      log(`  click 失败: ${e.message}`);
      // 尝试关闭可能阻挡的对话框
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(1500);
    }
    // 重新加载权限页（确保下次循环看到新状态）
    await gotoPermPage(page, appId);
  }

  log(`\n总共删除 ${removed} 项权限`);

  // 验证
  const text = await page.locator('body').innerText();
  const codes = [...new Set([...text.matchAll(/im[:\.][a-zA-Z0-9_:.\-]+/g)].map(m => m[0]))];
  log(`最终剩余权限: ${JSON.stringify(codes)}`);

  writeFileSync(STATE_FILE, JSON.stringify(await page.context().storageState()));
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
