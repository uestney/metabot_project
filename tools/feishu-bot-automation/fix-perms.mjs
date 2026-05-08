/**
 * fix-perms.mjs - 给指定 bot 补齐 7 项标准消息权限
 *
 * 思路：
 *   - 单次开抽屉，批量勾选所有缺失权限，一次性确认（避免 drawer mask 动画冲突）
 *   - 抽屉内：搜索一个权限 → 找到行内 checkbox → 勾选 → 清空搜索 → 下一个
 *   - 全部勾完后点"确认开通权限"提交
 *
 * 用法: node fix-perms.mjs <BOT_NAME|ALL>
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { loadBotsAppIds, STATE_FILE, SCREENSHOTS_DIR } from './_lib.mjs';

const SD = SCREENSHOTS_DIR;
mkdirSync(SD, { recursive: true });

const BOTS = loadBotsAppIds();

const TARGET_PERMS = [
  'im:message',
  'im:message:readonly',
  'im:message.p2p_msg:readonly',
  'im:message.group_at_msg:readonly',
  'im:message.group_msg',
  'im:resource',
  'im:chat:readonly',
];

const arg = process.argv[2];
const TARGETS = arg === 'ALL' ? BOTS : (BOTS[arg] ? { [arg]: BOTS[arg] } : null);
if (!TARGETS) {
  console.error(`用法: node fix-perms.mjs <${Object.keys(BOTS).join('|')}|ALL>`);
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

async function getCurrentPerms(page) {
  const text = await page.locator('body').innerText();
  const codes = [...new Set([...text.matchAll(/im[:\.][a-zA-Z0-9_:.\-]+/g)].map(m => m[0]))];
  return codes;
}

async function fixOneBot(page, name, appId) {
  log(`\n========== ${name} ==========`);
  await gotoPermPage(page, appId);
  await page.screenshot({ path: `${SD}/v4-${name}-before.png`, fullPage: true });

  const before = await getCurrentPerms(page);
  log(`  现有权限 (${before.length}): ${JSON.stringify(before)}`);
  const missing = TARGET_PERMS.filter(p => !before.includes(p));
  log(`  缺失 (${missing.length}): ${JSON.stringify(missing)}`);

  if (missing.length === 0) {
    log('  无需修复');
    return { name, before, after: before, missing: [] };
  }

  // 打开"开通权限"抽屉
  log('  打开开通权限抽屉');
  await page.locator('button:has-text("开通权限")').first().click();
  await sleep(5000);

  const drawer = page.locator('.ud__drawer__wrapper, [role="dialog"]').first();
  if (!(await drawer.isVisible({ timeout: 5000 }).catch(() => false))) {
    log('  ! 抽屉没出现');
    return { name, before, after: before, error: 'no_drawer' };
  }
  await page.screenshot({ path: `${SD}/v4-${name}-drawer-open.png`, fullPage: true });

  // 抽屉内的搜索框
  const searchInput = drawer.locator('input[placeholder*="例如"], input[type="text"]').first();
  if (!(await searchInput.isVisible({ timeout: 3000 }).catch(() => false))) {
    log('  ! 抽屉里找不到搜索框');
    return { name, before, after: before, error: 'no_search' };
  }

  let totalChecked = 0;
  for (const perm of missing) {
    log(`    搜索 ${perm}`);
    await searchInput.click();
    // 用三击 + 删除 来清空（避免上一次的内容残留）
    await page.keyboard.press('Control+a').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});
    await sleep(300);
    await searchInput.fill(perm);
    await sleep(3000);  // 等搜索结果

    // 找到包含 perm 编码文本的行，勾选其中的 checkbox
    // 飞书的 checkbox 是自定义元素，通常 input[type=checkbox] 是隐藏的，可见的是 <span class="ud__checkbox">
    // 策略：找到包含 perm 文本的容器，再找该容器内的 checkbox 元素
    const row = drawer.locator(`tr:has-text("${perm}"), [class*="row"]:has-text("${perm}"), li:has-text("${perm}")`).first();

    if (!(await row.isVisible({ timeout: 3000 }).catch(() => false))) {
      log(`      ! 没找到 ${perm} 行`);
      continue;
    }

    // 检查是不是已添加
    const rowText = await row.innerText().catch(() => '');
    if (rowText.includes('已添加')) {
      log(`      已添加，跳过`);
      continue;
    }

    // 在行内查找 checkbox (隐藏的 input + 它的可见容器)
    // 飞书可能使用 ud__checkbox 类
    const cbInput = row.locator('input[type="checkbox"]').first();
    const cbVisual = row.locator('.ud__checkbox, [class*="checkbox"]').first();

    let clickedTarget = null;
    if (await cbVisual.isVisible({ timeout: 2000 }).catch(() => false)) {
      clickedTarget = cbVisual;
    } else if (await cbInput.count().catch(() => 0)) {
      clickedTarget = cbInput;
    }

    if (clickedTarget) {
      await clickedTarget.click({ force: true }).catch(async () => {
        // 退而求其次：点击行本身
        await row.click({ force: true }).catch(() => {});
      });
      await sleep(800);
      totalChecked++;
      log(`      勾选 OK`);
    } else {
      log(`      ! 行内找不到 checkbox`);
    }
  }

  log(`  共勾选 ${totalChecked} 项`);
  await page.screenshot({ path: `${SD}/v4-${name}-drawer-selected.png`, fullPage: true });

  // 提交"确认开通权限"
  log('  点击确认开通权限');
  const confirmBtn = drawer.locator('button:has-text("确认开通权限"), button:has-text("确认")').last();
  if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    const enabled = await confirmBtn.isEnabled().catch(() => false);
    log(`    confirm 按钮状态: enabled=${enabled}`);
    await confirmBtn.click({ force: true }).catch(e => log(`    confirm click error: ${e.message}`));
    await sleep(8000);
  } else {
    log('  ! 找不到确认按钮');
  }
  await page.screenshot({ path: `${SD}/v4-${name}-after-confirm.png`, fullPage: true });

  // 重新读取权限页
  await gotoPermPage(page, appId);
  await page.screenshot({ path: `${SD}/v4-${name}-after.png`, fullPage: true });

  const after = await getCurrentPerms(page);
  const stillMissing = TARGET_PERMS.filter(p => !after.includes(p));
  log(`  最终权限 (${after.length}): ${JSON.stringify(after)}`);
  log(`  仍缺失: ${JSON.stringify(stillMissing)}`);

  // 保存浏览器状态
  writeFileSync(STATE_FILE, JSON.stringify(await page.context().storageState()));

  return { name, before, after, missing, stillMissing, totalChecked };
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
  for (const [name, appId] of Object.entries(TARGETS)) {
    try { results.push(await fixOneBot(page, name, appId)); }
    catch (e) { results.push({ name, error: e.message }); log(`FATAL ${name}: ${e.message}`); }
  }

  await browser.close();
  console.log('\n\n========== SUMMARY ==========');
  console.log(JSON.stringify(results, null, 2));
  writeFileSync(new URL('./fix-perms-results.json', import.meta.url),
                JSON.stringify(results, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
