/**
 * setup-events.mjs — 配置飞书应用的事件订阅（长连接 + im.message.receive_v1）
 *
 * 完整流程：
 *   1. 进入事件与回调页面
 *   2. 设置订阅方式为"长连接"
 *   3. 添加 im.message.receive_v1 事件
 *
 * ⚠️  踩坑记录：
 *   - 订阅方式的编辑按钮是"订阅方式"文字右侧的一个小 SVG 笔形图标，
 *     Playwright 无法直接定位它，需要通过坐标点击（文字右侧 +20px 处）
 *   - 添加事件打开的是一个 [role="dialog"] 模态对话框（不是 drawer）
 *   - 对话框左侧有分类列表（身份验证、通讯录、消息与群组…），
 *     可以点分类筛选，也可以用顶部搜索框搜索
 *   - ⚠️ 搜索时用 im.message.receive_v1 精确搜索最可靠，避免勾错事件
 *   - 勾选 checkbox 后底部显示"已选择 N 个事件"，然后点"添加"按钮
 *   - 添加后飞书可能弹出"建议添加权限"对话框，需要点确认
 *   - 配置长连接后，bot 服务必须在运行中才能验证连接
 *
 * 用法: node setup-events.mjs <BOT_NAME|ALL>
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { loadBotsAppIds, STATE_FILE, SCREENSHOTS_DIR } from './_lib.mjs';

const SD = SCREENSHOTS_DIR;
mkdirSync(SD, { recursive: true });

const BOTS = loadBotsAppIds();
const arg  = process.argv[2];

const TARGETS = arg === 'ALL'
  ? BOTS
  : (BOTS[arg] ? { [arg]: BOTS[arg] } : null);

if (!TARGETS) {
  console.error(`用法: node setup-events.mjs <${Object.keys(BOTS).join('|')}|ALL>`);
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }

async function setupOneBot(page, name, appId) {
  log(`\n========== ${name} (${appId}) ==========`);

  // ===== Step 1: 进入事件与回调页面 =====
  log('[1] 进入事件与回调页面');
  await page.goto(`https://open.feishu.cn/app/${appId}/event/`, {
    waitUntil: 'networkidle', timeout: 60000,
  });
  await sleep(8000);
  await page.keyboard.press('Escape'); // 关闭可能的提示气泡
  await sleep(500);

  const bodyText = await page.locator('body').innerText();

  // ===== Step 2: 检查并配置订阅方式 =====
  log('[2] 检查订阅方式');
  const hasLongConn = bodyText.includes('长连接');
  const notConfigured = bodyText.includes('未配置');

  if (hasLongConn && !notConfigured) {
    log('  订阅方式已配置为长连接，跳过');
  } else {
    log('  配置订阅方式为长连接');
    // 点击"订阅方式"文字右侧的编辑笔图标
    const label = page.locator('text=订阅方式').first();
    const box   = await label.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width + 20, box.y + box.height / 2);
      await sleep(3000);

      // 点击"长连接"选项
      const longConnOption = page.locator('text=长连接').first();
      if (await longConnOption.isVisible({ timeout: 5000 }).catch(() => false)) {
        await longConnOption.click();
        await sleep(2000);

        // 点击确认/保存
        const confirmBtn = page.locator('button:has-text("确认"), button:has-text("保存"), button:has-text("确定")').first();
        if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await confirmBtn.click();
          log('  长连接配置已保存');
          await sleep(5000);
        }
      } else {
        log('  ⚠️ 找不到长连接选项');
      }
    } else {
      log('  ⚠️ 找不到订阅方式标签');
    }
  }

  // ===== Step 3: 检查并添加 im.message.receive_v1 事件 =====
  log('[3] 检查已有事件');

  // 刷新页面确保获取最新状态
  await page.goto(`https://open.feishu.cn/app/${appId}/event/`, {
    waitUntil: 'networkidle', timeout: 60000,
  });
  await sleep(8000);
  await page.keyboard.press('Escape');
  await sleep(500);

  const updatedText = await page.locator('body').innerText();
  if (updatedText.includes('im.message.receive_v1') || updatedText.includes('接收消息')) {
    log('  im.message.receive_v1 事件已存在，跳过');
    return { name, status: 'already_configured' };
  }

  log('  添加 im.message.receive_v1 事件');

  // 点击"添加事件"按钮
  const addEventBtn = page.locator('button:has-text("添加事件")').first();
  if (!(await addEventBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
    log('  ⚠️ 找不到"添加事件"按钮');
    return { name, status: 'no_add_button' };
  }

  await addEventBtn.click();
  await sleep(5000);

  const dialog = page.locator('[role="dialog"]').last();

  // 用搜索框精确搜索（避免勾选错误的事件）
  const searchInput = dialog.locator('input[placeholder*="搜索"]').first();
  if (await searchInput.isVisible({ timeout: 5000 }).catch(() => false)) {
    await searchInput.click();
    await searchInput.fill('im.message.receive_v1');
    await sleep(4000);
  } else {
    log('  ⚠️ 搜索框不可见，尝试点击消息与群组分类');
    const msgCategory = dialog.locator('text=消息与群组').first();
    if (await msgCategory.isVisible({ timeout: 3000 }).catch(() => false)) {
      await msgCategory.click();
      await sleep(3000);
    }
  }

  // 勾选 checkbox
  const checkboxes = dialog.locator('input[type="checkbox"]');
  const cbCount    = await checkboxes.count();
  let checked      = false;

  for (let i = 0; i < cbCount; i++) {
    const cb        = checkboxes.nth(i);
    const isChecked = await cb.isChecked().catch(() => true);
    if (!isChecked) {
      await cb.click({ force: true });
      checked = true;
      log(`  勾选了 checkbox ${i}`);
      await sleep(1000);
      break;
    }
  }

  if (!checked) {
    log('  ⚠️ 没有找到可勾选的 checkbox');
    // 关闭对话框
    const cancelBtn = dialog.locator('button:has-text("取消")').first();
    if (await cancelBtn.isVisible().catch(() => false)) await cancelBtn.click();
    return { name, status: 'no_checkbox' };
  }

  // 检查选择计数
  const dialogText = await dialog.innerText().catch(() => '');
  const selMatch   = dialogText.match(/已选择 (\d+) 个事件/);
  log(`  ${selMatch ? selMatch[0] : '选择状态未知'}`);

  // 点击"添加"按钮
  const addBtn = dialog.locator('button:has-text("添加")').last();
  if (await addBtn.isEnabled({ timeout: 3000 }).catch(() => false)) {
    await addBtn.click();
    log('  点击了添加');
    await sleep(5000);

    // 处理可能的"建议添加权限"后续对话框
    for (let i = 0; i < 3; i++) {
      const followUp = page.locator('[role="dialog"]:visible').last();
      const followBtn = followUp.locator('button:visible').last();
      if (await followBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        const txt = await followBtn.innerText();
        if (txt.includes('添加') || txt.includes('确认') || txt.includes('确定')) {
          log(`  后续对话框: ${txt}`);
          await followBtn.click();
          await sleep(3000);
        } else break;
      } else break;
    }
  } else {
    log('  ⚠️ 添加按钮不可用（checkbox 可能没选中）');
    return { name, status: 'add_disabled' };
  }

  // 验证
  await sleep(3000);
  const finalText = await page.locator('body').innerText();
  const success   = finalText.includes('im.message.receive') || finalText.includes('接收消息');
  log(`  最终验证: ${success ? '成功' : '失败'}`);

  await page.screenshot({ path: `${SD}/events-${name}-done.png`, fullPage: true });
  writeFileSync(STATE_FILE, JSON.stringify(await page.context().storageState()));

  return { name, status: success ? 'configured' : 'unverified' };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    storageState: STATE_FILE,
  });
  const page = await context.newPage();

  // 验证登录
  await page.goto('https://open.feishu.cn/app', { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(6000);
  if (page.url().includes('login')) { log('SESSION EXPIRED'); process.exit(1); }
  log('login OK');

  const results = [];
  for (const [name, appId] of Object.entries(TARGETS)) {
    try {
      results.push(await setupOneBot(page, name, appId));
    } catch (e) {
      log(`FATAL ${name}: ${e.message}`);
      results.push({ name, status: 'error', error: e.message });
    }
  }

  await browser.close();
  console.log('\n\n========== RESULTS ==========');
  console.log(JSON.stringify(results, null, 2));
  writeFileSync(new URL('./setup-events-results.json', import.meta.url),
    JSON.stringify(results, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
