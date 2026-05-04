/**
 * 飞书卡片 2.0 schema 构造器（A2 方案）
 *
 * 跟 card-builder.ts (v1) 并存，通过 CARD_SCHEMA_V2 env 切换。
 *
 * 核心改进：
 *   - markdown 标题 → text_size 阶梯渲染（H1 最大、H6 退化粗体）
 *   - markdown 表格 → 原生 tag: 'table' 元素（可滚动、对齐、可点击）
 *   - 代码块     → 独立 tag: 'code_block' 元素（带语法高亮 + 复制按钮）
 *   - 其他       → tag: 'markdown'（飞书已支持，保持原样）
 */
import type { CardState, CardStatus } from '../types.js';
import { parseMarkdownToBlocks, type Block } from './markdown-parser.js';

const STATUS_CONFIG: Record<CardStatus, { color: string; title: string; icon: string }> = {
  thinking: { color: 'blue', title: 'Thinking...', icon: '🔵' },
  running: { color: 'blue', title: 'Running...', icon: '🔵' },
  complete: { color: 'green', title: 'Complete', icon: '🟢' },
  error: { color: 'red', title: 'Error', icon: '🔴' },
  waiting_for_input: { color: 'yellow', title: 'Waiting for Input', icon: '🟡' },
};

/**
 * Feishu card JSON limit is ~30KB.
 * Reserve bytes for card structure (header, config, tool calls, stats footer).
 * Must check BYTE length, not character count — CJK chars are 3 bytes each,
 * so 28000 chars of Chinese = 84KB, way over the limit.
 */
const MAX_CONTENT_BYTES = 20000;

function truncateContent(text: string): string {
  const byteLen = Buffer.byteLength(text, 'utf8');
  if (byteLen <= MAX_CONTENT_BYTES) return text;
  // Estimate char-to-byte ratio for this specific text (e.g. 0.33 for CJK, 1.0 for ASCII)
  const ratio      = text.length / byteLen;
  const targetChars = Math.floor(MAX_CONTENT_BYTES * ratio * 0.95); // 5% safety margin
  const half        = Math.floor(targetChars / 2) - 50;
  return text.slice(0, half) + '\n\n... (content truncated) ...\n\n' + text.slice(-half);
}

/**
 * 飞书 v2 markdown 元素上的 `text_size` 属性实测对 markdown 内容不生效（H2 看起来跟正文一样大）。
 * 改用 lark-markdown 的 `<font size="N">` 扩展语法，实测可改字号（HTML font 标签子集）。
 * 数字越大字越大（参照 HTML font size 1-7）。
 */
const HEADING_FONT_SIZE: Record<1 | 2 | 3 | 4 | 5 | 6, number> = {
  1: 6, // 一级 最大
  2: 5, // 二级
  3: 4, // 三级
  4: 3, // 四级 / H4 同正文偏大
  5: 3,
  6: 3,
};

/** 正文字号：稍微比飞书 markdown 默认小一号，匹配主人发消息的字号 */
const BODY_FONT_SIZE = 3;
/** Footer 字号：最小，作为状态栏 */
const FOOTER_FONT_SIZE = 2;

function blockToElement(block: Block): unknown {
  switch (block.type) {
    case 'heading':
      // 经多次实验：飞书 v2 markdown 元素的 text_size 属性对内容不生效，<font size> 也不被识别。
      // 改用最稳的方案 — 把标题渲染成 lark_md 包在 div 里。lark-md 解析器可能识别 "# Title" 真渲染成标题。
      // div 是 v1/v2 都支持的"通用文本容器"。
      return {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '#'.repeat(block.level) + ' ' + block.text,
        },
      };

    case 'table': {
      const columns = block.headers.map((h, i) => ({
        name: `col${i}`,
        display_name: h,
        // 用 text 而不是 markdown，可能给小一号默认字号
        data_type: 'text',
        horizontal_align: block.align[i] ?? 'left',
        vertical_align: 'center',
        width: 'auto',
      }));
      const rows = block.rows.map((row) => {
        const obj: Record<string, string> = {};
        row.forEach((cell, i) => {
          obj[`col${i}`] = cell;
        });
        return obj;
      });
      return {
        tag: 'table',
        page_size: 10,
        row_height: 'low',
        header_style: {
          text_align: 'center',
          background_style: 'grey',
          bold: true,
          lines: 1,
        },
        columns,
        rows,
      };
    }

    case 'codeblock':
      // 实测飞书 v2 schema 既不支持 'code' 也不支持 'code_block' tag。
      // 退回 markdown ``` 围栏，飞书 markdown 引擎自己处理代码块（无右上角复制按钮）。
      return {
        tag: 'markdown',
        content: '```\n' + block.code + '\n```',
      };

    case 'hr':
      return { tag: 'hr' };

    case 'markdown':
      // 正文：原样传 markdown，飞书 markdown 引擎自己处理 bold/italic/list/inline-code 等
      return {
        tag: 'markdown',
        content: block.text,
        text_align: 'left',
      };
  }
}

/**
 * 飞书 code_block 支持的 language 枚举（部分）：
 *   typescript / javascript / python / java / go / rust / shell / bash / json / yaml / sql / markdown / html / css / xml / plaintext
 * 把常见别名归一化。
 */
function normalizeLang(lang: string): string {
  const l = (lang || '').toLowerCase().trim();
  const map: Record<string, string> = {
    js: 'javascript',
    ts: 'typescript',
    py: 'python',
    sh: 'shell',
    bash: 'shell',
    md: 'markdown',
    yml: 'yaml',
    txt: 'plaintext',
    '': 'plaintext',
  };
  return map[l] ?? l;
}

/**
 * 把响应文本拆 block 然后映射成 v2 元素数组
 */
function responseToElements(text: string): unknown[] {
  const truncated = truncateContent(text);
  const blocks = parseMarkdownToBlocks(truncated);
  return blocks.map(blockToElement);
}

export function buildCardV2(state: CardState): string {
  const config = STATUS_CONFIG[state.status];
  const elements: unknown[] = [];

  // 工具调用列表
  if (state.toolCalls.length > 0) {
    const toolLines = state.toolCalls.map((t) => {
      const icon = t.status === 'running' ? '⏳' : '✅';
      return `${icon} **${t.name}** ${t.detail}`;
    });
    elements.push({
      tag: 'markdown',
      content: toolLines.join('\n'),
    });
    elements.push({ tag: 'hr' });
  }

  // 主响应内容（拆 block）
  if (state.responseText) {
    elements.push(...responseToElements(state.responseText));
  } else if (state.status === 'thinking') {
    elements.push({
      tag: 'markdown',
      content: '_Claude is thinking..._',
    });
  }

  // pending question
  if (state.pendingQuestion) {
    elements.push({ tag: 'hr' });
    const questionLines: string[] = [];
    for (const q of state.pendingQuestion.questions) {
      questionLines.push(`**[${q.header}] ${q.question}**`);
      questionLines.push('');
      q.options.forEach((opt, i) => {
        questionLines.push(`**${i + 1}.** ${opt.label} — _${opt.description}_`);
      });
      questionLines.push(`**${q.options.length + 1}.** Other（输入自定义回答）`);
      questionLines.push('');
    }
    questionLines.push('_回复数字选择，或直接输入自定义答案_');
    elements.push({
      tag: 'markdown',
      content: questionLines.join('\n'),
    });
  }

  // 错误
  if (state.errorMessage) {
    elements.push({
      tag: 'markdown',
      content: `**Error:** ${state.errorMessage}`,
    });
  }

  // stats note
  {
    const parts: string[] = [];
    if (state.totalTokens && state.contextWindow) {
      const pct = Math.round((state.totalTokens / state.contextWindow) * 100);
      const tokensK = state.totalTokens >= 1000 ? `${(state.totalTokens / 1000).toFixed(1)}k` : `${state.totalTokens}`;
      const ctxK = `${Math.round(state.contextWindow / 1000)}k`;
      parts.push(`ctx: ${tokensK}/${ctxK} (${pct}%)`);
    }
    if (state.status === 'complete' || state.status === 'error') {
      if (state.sessionCostUsd != null) parts.push(`$${state.sessionCostUsd.toFixed(2)}`);
      if (state.model) parts.push(state.model.replace(/^claude-/, ''));
      if (state.durationMs !== undefined) parts.push(`${(state.durationMs / 1000).toFixed(1)}s`);
    }
    if (parts.length > 0) {
      // footer 风格：column_set 灰色背景 + 内边距 padding 让文字距背景边框留空
      // - background_style: 'grey' 灰色底
      // - margin top 跟正文留 12px 距离
      // - column 上加 padding 让文字距右边 border 有 12px 内边距
      elements.push({
        tag: 'column_set',
        background_style: 'grey',
        margin: '12px 0px 0px 0px',
        horizontal_spacing: '0px',
        columns: [
          {
            tag: 'column',
            width: 'weighted',
            weight: 1,
            vertical_align: 'center',
            padding: '6px 12px 6px 12px',
            elements: [
              {
                tag: 'markdown',
                content: `<font color="grey" size="${FOOTER_FONT_SIZE}">_${parts.join(' | ')}_</font>`,
                text_align: 'right',
              },
            ],
          },
        ],
      });
    }
  }

  const card = {
    schema: '2.0',
    config: {
      streaming_mode: false,
      enable_forward: true,
      update_multi: true,
      summary: {
        content: state.responseText
          ? state.responseText.replace(/[\r\n]+/g, ' ').slice(0, 60)
          : config.title,
      },
    },
    header: {
      template: config.color,
      title: {
        tag: 'plain_text',
        content: `${config.icon} ${config.title}`,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '4px',
      elements,
    },
  };

  return JSON.stringify(card);
}

/** v2 帮助卡片 */
export function buildHelpCardV2(): string {
  const card = {
    schema: '2.0',
    config: { enable_forward: true, update_multi: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '📖 Help' },
    },
    body: {
      direction: 'vertical',
      elements: [
        {
          tag: 'markdown',
          content: [
            '**Available Commands:**',
            '`/reset` - Clear session, start fresh',
            '`/stop` - Abort current running task',
            '`/status` - Show current session info',
            '`/memory` - Memory document commands',
            '`/help` - Show this help message',
            '',
            '**Usage:**',
            'Send any text message to start a conversation with Claude Code.',
            'Each chat has an independent session with a fixed working directory.',
          ].join('\n'),
        },
      ],
    },
  };
  return JSON.stringify(card);
}

/** v2 状态卡片 */
export function buildStatusCardV2(
  userId: string,
  workingDirectory: string,
  sessionId: string | undefined,
  isRunning: boolean,
): string {
  const card = {
    schema: '2.0',
    config: { enable_forward: true, update_multi: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '📊 Status' },
    },
    body: {
      direction: 'vertical',
      elements: [
        {
          tag: 'markdown',
          content: [
            `**User:** \`${userId}\``,
            `**Working Directory:** \`${workingDirectory}\``,
            `**Session:** ${sessionId ? `\`${sessionId.slice(0, 8)}...\`` : '_None_'}`,
            `**Running:** ${isRunning ? 'Yes ⏳' : 'No'}`,
          ].join('\n'),
        },
      ],
    },
  };
  return JSON.stringify(card);
}

/** v2 通用文本卡片 */
export function buildTextCardV2(title: string, content: string, color: string = 'blue'): string {
  const card = {
    schema: '2.0',
    config: { enable_forward: true, update_multi: true },
    header: {
      template: color,
      title: { tag: 'plain_text', content: title },
    },
    body: {
      direction: 'vertical',
      elements: [
        {
          tag: 'markdown',
          content,
        },
      ],
    },
  };
  return JSON.stringify(card);
}
