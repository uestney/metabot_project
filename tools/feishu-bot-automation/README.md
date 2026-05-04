# Feishu Bot Automation (Playwright)

为 MetaBot 项目自动化操作飞书开放平台的 Web 控制台 —— 主要用于**给 bot 应用赋予权限和发布版本**。

通过 Playwright 驱动 Chromium 模拟真人操作飞书开发者后台 (https://open.feishu.cn/app)，
解决了几个手工操作的痛点：

1. **批量配置 7 个 bot 同款权限**：手动一个个加 7 项权限太累
2. **新 bot 的版本发布**：飞书的 `/apprelease` URL 会被 SPA 重定向，手动定位"创建版本"按钮繁琐
3. **bot 权限诊断**：一眼看完所有 bot 的当前权限状况

## 脚本一览

| 脚本 | 用途 |
|------|------|
| `login.mjs` | 飞书开放平台扫码登录，把浏览器 storageState 存到 `state.json` 供后续脚本复用 |
| `get-qr.mjs` | 单纯抓登录二维码（不轮询登录状态） |
| `diag-perms.mjs` | **只读**遍历所有 bot 当前权限，输出报告 |
| `fix-perms.mjs` | 给指定 bot 补齐 7 项标准消息权限（`im:message`, `im:message:readonly`, `im:resource` 等） |
| `clear-perms.mjs` | 清空指定 bot 的所有权限（每行点"关闭"） |
| `publish.mjs` | 创建 + 发布 bot 应用的最新版本（让权限/事件订阅生效） |
| `_lib.mjs` | 共享工具，从项目根 `bots.json` 读取 bot App ID 列表，定义状态/截图目录 |

## 使用前提

1. 安装依赖：
   ```bash
   cd tools/feishu-bot-automation
   npm install
   npx playwright install chromium
   ```

2. 项目根目录有 `bots.json`，结构形如：
   ```json
   {
     "feishuBots": [
       { "name": "invoker",  "feishuAppId": "cli_...", "feishuAppSecret": "...", "defaultWorkingDirectory": "..." },
       { "name": "nec-bot",  "feishuAppId": "cli_...", "feishuAppSecret": "...", "defaultWorkingDirectory": "..." }
     ]
   }
   ```
   脚本只读 `feishuAppId`，不需要也不会处理 `feishuAppSecret`。

3. 飞书账号已是项目里这些 App 的开发者/所有者。

## 典型工作流

### 第一次使用：登录

```bash
node login.mjs
```

脚本会：
1. 打开 https://open.feishu.cn/app
2. 截下登录二维码到 `screenshots/qr-code.png`
3. 轮询 5 分钟等您扫码登录
4. 登录成功后把 cookie/session 存到 `state.json`

> 如果设置了 `OUTPUT_CHAT_ID=oc_xxx` 环境变量，二维码会同步 copy 一份到
> `/tmp/metabot-outputs/<chatId>/`，借助 metabot 的 outputs 机制让飞书用户直接收到二维码图片，
> 这样在终端里通过 invoker bot 调用此脚本时可以直接在飞书里扫码。

### 给新 bot 配齐权限并发布

```bash
# 1. 看当前所有 bot 的权限状态
node diag-perms.mjs

# 2. 给某个 bot（比如 sf-bot）加齐 7 项标准权限
node fix-perms.mjs sf-bot

# 3. 发布该 bot 的新版本
node publish.mjs sf-bot

# 4. 一次性给全部 bot 补权限并发布
node fix-perms.mjs ALL
node publish.mjs ALL
```

### 权限错乱时清空重来

```bash
node clear-perms.mjs sf-bot   # 清空所有权限
node fix-perms.mjs sf-bot     # 重新加 7 项标准权限
node publish.mjs sf-bot       # 发布
```

## 标准 7 项消息权限（`fix-perms.mjs` 内置目标）

| 权限 | 说明 |
|------|------|
| `im:message` | 发送+接收消息（主权限） |
| `im:message:readonly` | 接收消息（只读） |
| `im:message.p2p_msg:readonly` | **私聊接收，关键** |
| `im:message.group_at_msg:readonly` | 群里 @ 机器人接收 |
| `im:message.group_msg` | 群组所有消息（敏感权限） |
| `im:resource` | 上传/下载图片文件 |
| `im:chat:readonly` | 读取群组信息 |

## 安全 / 隐私

- `state.json` (浏览器 cookie + token)、`browser-state.json`、`screenshots/`、`*-results.json`、`secrets.json`、`login-status.txt` 已在 `.gitignore` 中
- 所有脚本不存储任何 App Secret，只读 App ID
- 脚本本身**不含任何账号/凭据/截图**，可以安全地 commit 进 git

## 已知限制

- "创建新 bot" 的脚本未提交（早期探索代码，未稳定，删了）。
  目前主要靠这套脚本对**已创建**的 bot 做配置和发布操作。
  如需自动化创建，参考飞书开放平台 API 或手动在 Web 控制台创建后再用本工具集配置。
- 飞书 SPA 路由有时会把 `/permission`、`/apprelease` 等 URL 重定向回 `/credentials`，
  脚本里都改用"点击侧栏链接"或"点警告横幅按钮"的方式绕开。
