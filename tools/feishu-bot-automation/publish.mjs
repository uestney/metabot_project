/**
 * publish.mjs - 给 bot 发布最新版本
 *
 * 思路：
 *   1. 不直接 goto('/apprelease') —— 飞书会把这个 URL 重定向回 /credentials
 *   2. 改成点击 /credentials 页面顶部警告条上的"创建版本"或"查看版本详情"链接
 *   3. 在版本详情页点击"确认发布"
 *
 * 用法: node publish.mjs [BOT_NAME|ALL]
 *   不传 = 默认 ALL（全部 bot）
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { loadBotsAppIds, STATE_FILE, SCREENSHOTS_DIR } from './_lib.mjs';

const SD = SCREENSHOTS_DIR;
mkdirSync(SD, { recursive: true });

const BOTS = loadBotsAppIds();

const arg = process.argv[2];
const TARGETS = !arg || arg === 'ALL' ? BOTS : (BOTS[arg] ? { [arg]: BOTS[arg] } : null);
if (!TARGETS) {
  console.error(`用法: node publish.mjs <${Object.keys(BOTS).join('|')}|ALL>`);
  process.exit(1);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function ss(page, name) { await page.screenshot({ path: `${SD}/v2-${name}.png`, fullPage: true }).catch(() => {}); }

function log(msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }

async function logState(page, label) {
  const url = page.url();
  log(`  [${label}] URL = ${url}`);
  // List visible top-level buttons for debugging
  const btns = await page.locator('button:visible').allInnerTexts().catch(() => []);
  const sigBtns = btns.filter(t => t && t.length > 0 && t.length < 30 &&
    /创建|发布|保存|确认|确定|开通|添加|提交|申请|版本/.test(t));
  log(`  [${label}] notable buttons: ${JSON.stringify([...new Set(sigBtns)].slice(0, 10))}`);
}

async function publishOne(page, name, appId) {
  log(`\n========== ${name} (${appId}) ==========`);

  // Step A: 进入凭证页（这是稳定的入口）
  log('[A] goto credentials page');
  await page.goto(`https://open.feishu.cn/app/${appId}`, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(8000);
  await ss(page, `${name}-A-credentials`);
  await logState(page, 'A');

  if (page.url().includes('login') || page.url().includes('accounts')) {
    return { name, status: 'session_expired' };
  }

  // Step B: 找警告横幅 "版本发布后，当前修改可生效" 上的"创建版本"链接
  log('[B] search for 创建版本 link in warning banner');
  // 尝试多种选择器
  const createVerSelectors = [
    'a:has-text("创建版本")',
    'button:has-text("创建版本")',
    'span:has-text("创建版本")',
    'text=创建版本',
  ];

  let createBtn = null;
  for (const sel of createVerSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 3000 }).catch(() => false)) {
      createBtn = loc;
      log(`  found via selector: ${sel}`);
      break;
    }
  }

  // Branch: fresh app (no version yet) vs. existing-draft (version saved but not published)
  let draftAlreadyExists = false;
  if (!createBtn) {
    // Fallback: 查看版本详情 means a draft version exists and just needs publishing.
    // (Previous publish run may have saved the version form without confirming the
    // publish step — common when only "保存" was available in the form, not
    // "保存并发布". The page now exposes the publish action on the detail page.)
    const viewVer = page.locator('text=查看版本详情').first();
    if (await viewVer.isVisible({ timeout: 3000 }).catch(() => false)) {
      log('  no 创建版本 but found 查看版本详情 - clicking it (existing draft path)');
      await viewVer.click();
      await sleep(8000);
      draftAlreadyExists = true;
      await ss(page, `${name}-B-viewversion`);
      await logState(page, 'B-after-view');
    } else {
      log('  WARNING: no 创建版本 or 查看版本详情 found');
      const bodyText = await page.locator('body').innerText();
      log(`  body text snippet: ${bodyText.slice(0, 300)}`);
      return { name, status: 'no_create_button', url: page.url() };
    }
  } else {
    log('[C] click 创建版本');
    await createBtn.click();
    await sleep(8000);
    await ss(page, `${name}-C-after-create-click`);
    await logState(page, 'C');
  }

  // If we entered via the existing-draft path, jump straight to the
  // confirm-publish action on the detail page — there's no form to fill.
  if (draftAlreadyExists) {
    log('[D-skip] existing draft; looking for publish/confirm button on detail page');
    const detailPublishSelectors = [
      'button:has-text("确认发布")',
      'button:has-text("申请发布")',
      'button:has-text("提交发布")',
      'button:has-text("发布上线")',
      'button:has-text("立即发布")',
      'button:has-text("保存并发布")',
      'button:has-text("提交审核")',
      'button:has-text("发布")',
    ];
    let detailClicked = null;
    for (const sel of detailPublishSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false) &&
          await btn.isEnabled({ timeout: 1000 }).catch(() => false)) {
        log(`  clicking detail-page publish: ${sel}`);
        await btn.click();
        detailClicked = sel;
        await sleep(5000);
        break;
      }
    }
    await ss(page, `${name}-D-detail-clicked`);
    if (!detailClicked) {
      log('  WARNING: detail page has no actionable publish button');
      return { name, status: 'detail_no_publish_button', url: page.url() };
    }

    // Handle confirmation dialog if any
    for (let i = 0; i < 3; i++) {
      const dlg = page.locator('[role="dialog"] button:has-text("确认发布"), [role="dialog"] button:has-text("确认"), [role="dialog"] button:has-text("确定"), [role="dialog"] button:has-text("发布")').last();
      if (await dlg.isVisible({ timeout: 2500 }).catch(() => false)) {
        const txt = await dlg.innerText().catch(() => '?');
        log(`  dialog button: "${txt}"`);
        await dlg.click();
        await sleep(5000);
      } else {
        break;
      }
    }
    await ss(page, `${name}-D-detail-after-confirm`);
    await logState(page, 'D-detail');

    // Skip the form-fill (D) and form-submit (E) sections — we're done.
    // Go straight to verification.
    log('[G] verify - check 已发布 status on version page');
    await page.goto(`https://open.feishu.cn/app/${appId}`, { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(6000);
    const sidebarVerLink = page.locator('a:has-text("版本管理与发布"), :text("版本管理与发布")').first();
    if (await sidebarVerLink.isVisible({ timeout: 4000 }).catch(() => false)) {
      await sidebarVerLink.click();
      await sleep(5000);
    }
    await ss(page, `${name}-G-final`);
    const finalText = await page.locator('body').innerText();
    const published = /已发布|已启用|已上线/.test(finalText);
    log(`  detail-path verify: published=${published}`);

    const state = await page.context().storageState();
    writeFileSync(STATE_FILE, JSON.stringify(state));
    return {
      name,
      status: published ? 'published' : 'submitted_but_unverified',
      submittedVia: detailClicked,
      path: 'existing-draft',
    };
  }

  // Step D: 我们应该在版本管理页或者一个表单里。看是否需要填写版本号/描述
  // 寻找版本号输入框 + 更新说明 textarea
  log('[D] look for version form (version number + notes)');
  const verNumInput = page.locator('input[placeholder*="版本"], input[placeholder*="version"]').first();
  const ta = page.locator('textarea').first();

  if (await verNumInput.isVisible({ timeout: 5000 }).catch(() => false)) {
    log('  found 版本号 input - filling 1.0.0');
    await verNumInput.clear();
    await verNumInput.fill('1.0.0');
    await sleep(1500);
  } else {
    log('  no 版本号 input visible (may already be filled or not required)');
  }

  if (await ta.isVisible({ timeout: 5000 }).catch(() => false)) {
    log('  found textarea - filling release notes');
    await ta.clear();
    await ta.fill('MetaBot 桥接初始版本：开通机器人能力与事件订阅');
    await sleep(1500);
  } else {
    log('  no textarea visible');
  }

  await ss(page, `${name}-D-form-filled`);

  // Step E: 提交（保存 / 确认）
  log('[E] submit form');
  // 优先 "保存并发布"，其次 "保存"
  const submitSelectors = [
    'button:has-text("保存并发布")',
    'button:has-text("保存版本")',
    'button:has-text("申请发布")',
    'button:has-text("发布")',
    'button:has-text("保存")',
  ];

  let submittedVia = null;
  for (const sel of submitSelectors) {
    const btn = page.locator(sel).last();
    if (await btn.isVisible({ timeout: 3000 }).catch(() => false) &&
        await btn.isEnabled({ timeout: 1000 }).catch(() => false)) {
      log(`  clicking: ${sel}`);
      await btn.click();
      submittedVia = sel;
      await sleep(8000);
      break;
    }
  }
  await ss(page, `${name}-E-after-submit`);
  await logState(page, 'E');

  if (!submittedVia) {
    log('  WARNING: no submit button found');
    return { name, status: 'no_submit_button', url: page.url() };
  }

  // Step F: 处理后续弹窗（确认发布对话框）
  log('[F] handle confirmation dialog if any');
  for (let i = 0; i < 3; i++) {
    const confirmBtn = page.locator('[role="dialog"] button:has-text("确认发布"), [role="dialog"] button:has-text("确认"), [role="dialog"] button:has-text("确定")').last();
    if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      const txt = await confirmBtn.innerText().catch(() => '?');
      log(`  click dialog button: "${txt}"`);
      await confirmBtn.click();
      await sleep(6000);
    } else {
      break;
    }
  }
  await ss(page, `${name}-F-after-confirm`);
  await logState(page, 'F');

  // Step G: 验证 - 回到凭证页看警告横幅是否消失
  log('[G] verify - go back to credentials, check warning banner');
  await page.goto(`https://open.feishu.cn/app/${appId}`, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(6000);
  await ss(page, `${name}-G-final`);

  const finalText = await page.locator('body').innerText();
  const stillHasWarning = finalText.includes('版本发布后') && finalText.includes('当前修改可生效');
  log(`  warning banner still present: ${stillHasWarning}`);

  // 保存浏览器状态
  const state = await page.context().storageState();
  writeFileSync(STATE_FILE, JSON.stringify(state));

  return {
    name,
    status: stillHasWarning ? 'submitted_but_unverified' : 'published',
    submittedVia,
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

  // 验证登录
  log('[init] verifying login...');
  await page.goto('https://open.feishu.cn/app', { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(6000);
  if (page.url().includes('login') || page.url().includes('accounts')) {
    log('ERROR: session expired');
    await browser.close();
    process.exit(1);
  }
  log('login OK\n');

  const results = [];
  for (const [name, appId] of Object.entries(TARGETS)) {
    try {
      results.push(await publishOne(page, name, appId));
    } catch (e) {
      log(`FATAL on ${name}: ${e.message}`);
      await ss(page, `${name}-FATAL`);
      results.push({ name, status: 'error', error: e.message });
    }
  }

  await browser.close();
  console.log('\n\n========== RESULTS ==========');
  console.log(JSON.stringify(results, null, 2));
  writeFileSync(new URL('./publish-results.json', import.meta.url), JSON.stringify(results, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
