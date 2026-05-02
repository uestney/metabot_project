/**
 * Markdown → Block 序列 解析器
 *
 * 给飞书 v2 卡片用：把 Claude 的 markdown 输出拆成一个 block 序列，
 * 后续 card-builder-v2 把每种 block 映射成飞书原生组件（heading/table/code_block/markdown）。
 *
 * 用 marked 解析（处理嵌套/转义/对齐等边角 case），把它的 token 树扁平成我们要的 block 类型。
 */
import { marked, type Tokens } from 'marked';

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: 'table'; headers: string[]; align: ('left' | 'center' | 'right')[]; rows: string[][] }
  | { type: 'codeblock'; lang: string; code: string }
  | { type: 'hr' }
  | { type: 'markdown'; text: string };

/** 把 token 转回原 markdown 文本（passthrough block 用） */
function tokenToMarkdown(token: Tokens.Generic): string {
  return token.raw ?? '';
}

/**
 * 把 inline tokens 数组拍平成 markdown 字符串
 * 用于 heading 标题、表格 cell 这种 inline 上下文
 */
function inlineTokensToText(tokens: Tokens.Generic[] | undefined): string {
  if (!tokens) return '';
  return tokens.map((t) => t.raw ?? (t as any).text ?? '').join('');
}

export function parseMarkdownToBlocks(md: string): Block[] {
  if (!md) return [];

  // 配置 marked：禁用 mangle/headerIds（不需要 HTML 输出，只要 token 树）
  const tokens = marked.lexer(md);
  const blocks: Block[] = [];

  // 收集连续的 paragraph/list/blockquote 等"普通 markdown"，一并塞进一个 markdown block
  // 这样 飞书 native markdown 能完整渲染段落+列表+inline format
  let buffer: string[] = [];
  const flushBuffer = () => {
    if (buffer.length > 0) {
      const text = buffer.join('').trim();
      if (text) blocks.push({ type: 'markdown', text });
      buffer = [];
    }
  };

  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        flushBuffer();
        const t = token as Tokens.Heading;
        const level = Math.min(6, Math.max(1, t.depth)) as 1 | 2 | 3 | 4 | 5 | 6;
        blocks.push({
          type: 'heading',
          level,
          text: inlineTokensToText(t.tokens) || t.text,
        });
        break;
      }

      case 'table': {
        flushBuffer();
        const t = token as Tokens.Table;
        const headers = t.header.map((h) => h.text);
        const align = t.align.map((a) => (a === 'center' ? 'center' : a === 'right' ? 'right' : 'left'));
        const rows = t.rows.map((row) => row.map((cell) => cell.text));
        blocks.push({ type: 'table', headers, align, rows });
        break;
      }

      case 'code': {
        flushBuffer();
        const t = token as Tokens.Code;
        blocks.push({
          type: 'codeblock',
          lang: t.lang || '',
          code: t.text,
        });
        break;
      }

      case 'hr': {
        flushBuffer();
        blocks.push({ type: 'hr' });
        break;
      }

      // 段落 / 列表 / 引用 / 普通文本 → 原样塞 buffer，最后合并成一个 markdown block
      case 'paragraph':
      case 'list':
      case 'blockquote':
      case 'space':
      case 'text':
      case 'html':
      case 'br':
      default:
        buffer.push(tokenToMarkdown(token));
        break;
    }
  }

  flushBuffer();
  return blocks;
}
