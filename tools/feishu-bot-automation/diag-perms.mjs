/**
 * diag-perms.mjs - 只读检查所有 bot 当前权限配置
 * 通过点击侧栏链接进入权限页（避免 URL goto 被 SPA 重定向）
 *
 * 用法: node diag-perms.mjs
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { loadBotsAppIds, STATE_FILE, SCREENSHOTS_DIR } from './_lib.mjs';

const SD = SCREENSHOTS_DIR;
mkdirSync(SD, { recursive: true });

const BOTS = loadBotsAppIds();

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(m) { console.log(`[${new Date().toISOString().slice(11,19)}] ${m}`); }

async function inspect(page, name, appId) {
  log(`\n========== ${name} ==========`);

  // 进入应用主页（baseinfo）
  await page.goto(`https://open.feishu.cn/app/${appId}`, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(6000);
  log(`  baseinfo URL: ${page.url()}`);

  // 点击侧栏「权限管理」
  log('  click 权限管理 in sidebar');
  const permLink = page.locator('a:has-text("权限管理"), nav :text("权限管理"), [role="menuitem"]:has-text("权限管理")').first();
  if (await permLink.isVisible({ timeout: 5000 }).catch(() => false)) {
    await permLink.click();
    await sleep(8000);
  } else {
    // fallback: 通过 text 直接点
    const t = page.locator('text=权限管理').first();
    if (await t.isVisible({ timeout: 5000 }).catch(() => false)) {
      await t.click();
      await sleep(8000);
    } else {
      log('  ERROR: 找不到 权限管理 链接');
      return { name, appId, error: 'no_perm_link' };
    }
  }

  log(`  after click URL: ${page.url()}`);
  await page.screenshot({ path: `${SD}/diag2-${name}-perm.png`, fullPage: true });

  // 现在应该在权限页。提取已开通权限列表
  // 通常飞书页面会显示权限名称（中文 + im:xxx 编码或两者之一）
  const fullText = await page.locator('body').innerText();

  // 提取所有 im: 或 im. 开头的权限编码
  const codes = [...new Set([...fullText.matchAll(/im[:\.][a-zA-Z0-9_:.\-]+/g)].map(m => m[0]))].sort();

  // 查找页面是否有"已开通的权限"区域
  const hasGrantedSection = /已开通/.test(fullText);

  // 抓取页面中"权限列表"或"已开通"周围的文字（前 5KB）
  const grantedIdx = fullText.indexOf('已开通');
  const snippet = grantedIdx >= 0 ? fullText.slice(grantedIdx, grantedIdx + 3000) : fullText.slice(0, 3000);

  return {
    name,
    appId,
    finalUrl: page.url(),
    hasGrantedSection,
    permCodes: codes,
    snippet: snippet.replace(/\s+/g, ' ').slice(0, 1500),
  };
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

  const results = [];
  for (const [name, appId] of Object.entries(BOTS)) {
    try { results.push(await inspect(page, name, appId)); }
    catch (e) { results.push({ name, error: e.message }); }
  }

  await browser.close();

  console.log('\n\n========== SUMMARY ==========');
  for (const r of results) {
    console.log(`\n--- ${r.name} ---`);
    if (r.error) { console.log(`  error: ${r.error}`); continue; }
    console.log(`  URL: ${r.finalUrl}`);
    console.log(`  has 已开通 section: ${r.hasGrantedSection}`);
    console.log(`  perm codes found: ${JSON.stringify(r.permCodes)}`);
    console.log(`  snippet: ${r.snippet.slice(0, 600)}`);
  }

  writeFileSync(new URL('./diag-perms-results.json', import.meta.url),
                JSON.stringify(results, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
