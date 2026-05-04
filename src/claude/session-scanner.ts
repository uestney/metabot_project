/**
 * Session Scanner — scans ~/.claude/projects/ for local Claude Code desktop sessions.
 *
 * Each working directory maps to a folder under ~/.claude/projects/ with the path
 * encoded as hyphens (e.g. /vepfs/users/ameng/workspace/SF → -vepfs-users-ameng-workspace-SF).
 * Inside each folder, .jsonl files are individual sessions.
 *
 * This module extracts metadata from those files so invoker can present a list
 * of sessions to the user for project switching.
 */
import * as fs   from 'node:fs';
import * as path from 'node:path';
import * as os   from 'node:os';
import * as readline from 'node:readline';

export interface LocalSession {
  sessionId:    string;
  /** Absolute path to the .jsonl file */
  filePath:     string;
  /** Working directory this session belongs to */
  workingDir:   string;
  /** File size in bytes */
  sizeBytes:    number;
  /** Human-readable file size */
  sizeHuman:    string;
  /** Last modification time (epoch ms) */
  modifiedAt:   number;
  /** ISO string of modification time */
  modifiedAtStr: string;
  /** Number of lines in the file */
  lineCount:    number;
  /** First user message (truncated) — shows what the conversation was about */
  firstMessage: string;
  /** Last 2 user+assistant messages for history push */
  recentMessages: Array<{ role: string; content: string; timestamp?: string }>;
}

/**
 * Convert a working directory path to the Claude projects folder name.
 * Claude Code replaces both `/` and `_` with `-`.
 * /vepfs/users/ameng/workspace/metabot_SF → -vepfs-users-ameng-workspace-metabot-SF
 */
export function workDirToProjectFolder(workDir: string): string {
  return workDir.replace(/[/_]/g, '-');
}

/**
 * Find the best matching project folder for a working directory.
 * Since the encoding is lossy (both / and _ → -), we cannot reverse it exactly.
 * Instead we try exact match first, then scan all folders for potential matches.
 */
export function findProjectFolder(workDir: string): string | null {
  const projectsDir = getProjectsDir();
  if (!fs.existsSync(projectsDir)) return null;

  const expected = workDirToProjectFolder(workDir);

  // Exact match
  if (fs.existsSync(path.join(projectsDir, expected))) {
    return expected;
  }

  // If no exact match, the encoding might differ — scan and check
  const folders = fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  // Try to find a folder whose decoded form matches
  for (const folder of folders) {
    if (folder === expected) return folder;
  }

  return null;
}

/**
 * Get the Claude projects base directory.
 */
function getProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Scan all local sessions for a given working directory.
 * Returns sessions sorted by modification time (most recent first).
 */
export async function scanSessions(workDir: string): Promise<LocalSession[]> {
  const projectsDir = getProjectsDir();
  const folderName  = findProjectFolder(workDir);

  if (!folderName) {
    return [];
  }

  const sessionDir = path.join(projectsDir, folderName);

  const files = fs.readdirSync(sessionDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(sessionDir, f));

  const results: LocalSession[] = [];

  for (const filePath of files) {
    try {
      const session = await parseSessionFile(filePath, workDir);
      if (session) results.push(session);
    } catch {
      // Skip unreadable files
    }
  }

  // Sort by modification time, most recent first
  results.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return results;
}

/**
 * Scan all working directories that have local sessions.
 */
export function listProjectDirs(): Array<{ workDir: string; folder: string; sessionCount: number }> {
  const projectsDir = getProjectsDir();
  if (!fs.existsSync(projectsDir)) return [];

  const folders = fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter(d => d.isDirectory());

  return folders.map(d => {
    const fullPath     = path.join(projectsDir, d.name);
    const sessionCount = fs.readdirSync(fullPath).filter(f => f.endsWith('.jsonl')).length;
    return {
      workDir:      d.name, // Folder name (lossy encoding — cannot reliably reverse)
      folder:       d.name,
      sessionCount,
    };
  }).filter(d => d.sessionCount > 0);
}

/**
 * Parse a single .jsonl session file and extract metadata.
 */
async function parseSessionFile(filePath: string, workDir: string): Promise<LocalSession | null> {
  const stat      = fs.statSync(filePath);
  const sessionId = path.basename(filePath, '.jsonl');

  // Count lines and extract first user message + recent messages
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl     = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineCount    = 0;
  let firstMessage = '';
  const allMessages: Array<{ role: string; content: string; timestamp?: string }> = [];

  for await (const line of rl) {
    lineCount++;
    if (!line.trim()) continue;

    try {
      const obj = JSON.parse(line);

      // Extract user messages
      if (obj.type === 'user' && obj.message?.role === 'user') {
        const content = extractContent(obj.message.content);
        if (!firstMessage && content) {
          firstMessage = content.slice(0, 100);
        }
        allMessages.push({
          role:      'user',
          content:   content.slice(0, 500),
          timestamp: obj.timestamp,
        });
      }

      // Extract assistant messages (final text blocks)
      if (obj.message?.role === 'assistant' && obj.message?.content) {
        const content = extractContent(obj.message.content);
        if (content) {
          // Deduplicate: assistant messages may appear multiple times (streaming)
          const lastAssistant = allMessages.length > 0 && allMessages[allMessages.length - 1].role === 'assistant'
            ? allMessages[allMessages.length - 1]
            : null;
          if (lastAssistant && obj.message.id && lastAssistant.content) {
            // Update the last assistant message (streaming overwrites)
            lastAssistant.content = content.slice(0, 500);
          } else {
            allMessages.push({
              role:      'assistant',
              content:   content.slice(0, 500),
              timestamp: obj.timestamp,
            });
          }
        }
      }
    } catch {
      // Skip unparseable lines
    }
  }

  // Get the last 4 messages (2 turns of user+assistant)
  const recentMessages = allMessages.slice(-4);

  return {
    sessionId,
    filePath,
    workingDir:    workDir,
    sizeBytes:     stat.size,
    sizeHuman:     humanSize(stat.size),
    modifiedAt:    stat.mtimeMs,
    modifiedAtStr: new Date(stat.mtimeMs).toISOString().replace('T', ' ').slice(0, 19),
    lineCount,
    firstMessage,
    recentMessages,
  };
}

/**
 * Extract text content from a Claude message content field.
 * Content can be a string or an array of content blocks.
 */
function extractContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === 'text' && c.text)
      .map((c: any) => c.text)
      .join(' ')
      .trim();
  }
  return '';
}

/**
 * Format bytes to human-readable size.
 */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
