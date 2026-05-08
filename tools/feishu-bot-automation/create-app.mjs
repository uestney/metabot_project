/**
 * create-app.mjs — 在飞书开放平台自动创建新应用
 *
 * 完整流程：
 *   1. 打开 https://open.feishu.cn/app → 点击"创建企业自建应用"
 *   2. 填写应用名称和描述（React 受控输入，必须用 pressSequentially）
 *   3. 点击创建
 *   4. 通过拦截内部 API 获取真实 App Secret（页面文本始终是掩码 *** ）
 *   5. 添加机器人能力
 *   6. 输出凭证到 create-app-result.json
 *
 * ⚠️  踩坑记录：
 *   - 飞书控制台是 React SPA，input.fill() 无法触发 onChange，必须用 pressSequentially
 *   - 页面显示的 App Secret 永远是 *** 掩码，innerText 拿不到真实值
 *   - 真实 Secret 在页面加载凭证页时由 GET /developers/v1/secret/<appId> 返回
 *   - 添加机器人能力需要在"应用能力"页点击"添加应用能力" → 找到"机器人"卡片 → 点"添加"
 *
 * 用法: node create-app.mjs <APP_NAME> [DESCRIPTION]
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { STATE_FILE, SCREENSHOTS_DIR } from './_lib.mjs';

const SD = SCREENSHOTS_DIR;
mkdirSync(SD, { recursive: true });

const appName = process.argv[2];
const appDesc = process.argv[3] || `${appName} - MetaBot bridge bot`;

if (!appName) {
  console.error('用法: node create-app.mjs <APP_NAME> [DESCRIPTION]');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log(`Creating Feishu app: ${appName}`);
console.log(`Description: ${appDesc}`);

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: JSON.parse(readFileSync(STATE_FILE, 'utf-8')),
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();

  // ========== 拦截 secret API ==========
  // 飞书凭证页加载时会请求 /developers/v1/secret/<appId>，返回 {"code":0,"data":{"secret":"xxx"}}
  // 这是获取真实 App Secret 的唯一可靠方式
  let capturedSecret = '';
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/developers/v1/secret/')) {
      try {
        const body = await response.json();
        if (body?.data?.secret) {
          capturedSecret = body.data.secret;
        }
      } catch { /* ignore */ }
    }
  });

  // ========== Step 1: 打开应用列表 ==========
  console.log('1. Opening app list...');
  await page.goto('https://open.feishu.cn/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(5000);

  if (page.url().includes('login') || page.url().includes('passport')) {
    console.error('Not logged in! Run login.mjs first.');
    await browser.close();
    process.exit(1);
  }

  // ========== Step 2: 点击"创建企业自建应用" ==========
  console.log('2. Clicking create app button...');
  const createBtnSelectors = [
    'button:has-text("创建企业自建应用")',
    'button:has-text("创建应用")',
  ];

  let clicked = false;
  for (const sel of createBtnSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await btn.click();
      clicked = true;
      console.log(`   Clicked: ${sel}`);
      break;
    }
  }

  if (!clicked) {
    await page.screenshot({ path: `${SD}/create-02-no-btn.png` });
    console.error('Could not find create button.');
    await browser.close();
    process.exit(1);
  }

  await sleep(3000);

  // ========== Step 3: 填写应用名称和描述 ==========
  // ⚠️ 飞书控制台是 React SPA，input.fill() 不会触发 onChange
  //    必须用 pressSequentially 逐字符输入
  console.log('3. Filling app name and description...');

  const nameSelectors = [
    '[role="dialog"] input',
    'input[placeholder*="名称"]',
    'input[placeholder*="应用"]',
  ];
  let nameFilled = false;
  for (const sel of nameSelectors) {
    const inp = page.locator(sel).first();
    if (await inp.isVisible({ timeout: 3000 }).catch(() => false)) {
      await inp.click();
      await inp.press('Control+a');
      await inp.pressSequentially(appName, { delay: 50 });
      nameFilled = true;
      console.log(`   Name typed: "${appName}" (via ${sel})`);
      break;
    }
  }
  if (!nameFilled) console.error('   Could not find name input!');

  const descSelectors = [
    '[role="dialog"] textarea',
    'textarea[placeholder*="描述"]',
    'textarea',
  ];
  for (const sel of descSelectors) {
    const ta = page.locator(sel).first();
    if (await ta.isVisible({ timeout: 3000 }).catch(() => false)) {
      await ta.click();
      await ta.press('Control+a');
      await ta.pressSequentially(appDesc, { delay: 20 });
      console.log('   Description typed');
      break;
    }
  }

  // ========== Step 4: 点击创建 ==========
  console.log('4. Submitting...');
  const confirmSelectors = [
    '[role="dialog"] button:has-text("创建")',
    '[role="dialog"] button:has-text("确定")',
  ];

  for (const sel of confirmSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.click();
      console.log(`   Submitted via: ${sel}`);
      break;
    }
  }

  // 等待跳转到凭证页，网络拦截器会自动抓取 secret
  await sleep(8000);

  // ========== Step 5: 提取 App ID ==========
  console.log('5. Extracting credentials...');
  const currentUrl = page.url();
  console.log(`   Current URL: ${currentUrl}`);

  // 从 URL 或页面文本中提取 App ID
  let appId = '';
  const urlMatch = currentUrl.match(/cli_[a-f0-9]{16,}/);
  if (urlMatch) {
    appId = urlMatch[0];
  } else {
    const pageText = await page.textContent('body');
    const textMatch = pageText.match(/cli_[a-f0-9]{16,}/);
    if (textMatch) appId = textMatch[0];
  }
  console.log(`   App ID: ${appId || '(not found)'}`);

  // 如果网络拦截没抓到 secret，主动请求凭证页触发 API
  if (!capturedSecret && appId) {
    console.log('   Secret not captured yet, navigating to credentials page...');
    await page.goto(`https://open.feishu.cn/app/${appId}/baseinfo`, {
      waitUntil: 'networkidle', timeout: 60000,
    });
    await sleep(5000);
  }

  console.log(`   App Secret: ${capturedSecret ? capturedSecret.slice(0, 4) + '****' : '(not captured)'}`);

  // ========== Step 6: 添加机器人能力 ==========
  if (appId) {
    console.log('6. Adding bot capability...');
    await page.goto(`https://open.feishu.cn/app/${appId}/capability/`, {
      waitUntil: 'networkidle', timeout: 60000,
    });
    await sleep(5000);

    // 检查是否已有"机器人"菜单项
    const hasBotAlready = await page.locator('a:has-text("机器人")').first()
      .isVisible({ timeout: 2000 }).catch(() => false);

    if (!hasBotAlready) {
      // 点击"添加应用能力"
      const addCapBtn = page.locator('text=添加应用能力').first();
      if (await addCapBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await addCapBtn.click();
        await sleep(3000);
      }

      // 在能力列表中找到"机器人"卡片的"添加"按钮
      const botAddBtn = page.locator('text=机器人 >> xpath=../.. >> button:has-text("添加")').first();
      if (await botAddBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await botAddBtn.click();
        console.log('   Bot capability added');
        await sleep(3000);
      } else {
        console.log('   Could not find bot add button');
      }
    } else {
      console.log('   Bot capability already exists');
    }
  }

  // ========== 保存结果 ==========
  writeFileSync(STATE_FILE, JSON.stringify(await context.storageState()));

  const result = {
    appName,
    appDesc,
    appId,
    appSecret: capturedSecret,
    createdAt: new Date().toISOString(),
  };
  writeFileSync('create-app-result.json', JSON.stringify(result, null, 2));

  console.log(`\nResult: ${JSON.stringify(result, null, 2)}`);

  if (!appId)         console.error('\nWARNING: Could not extract App ID.');
  if (!capturedSecret) console.error('\nWARNING: Could not capture App Secret. Check network.');

  await browser.close();
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
