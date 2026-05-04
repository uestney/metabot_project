import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import type * as http from 'node:http';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { RouteContext } from './types.js';
import { scanSessions, listProjectDirs } from '../../claude/session-scanner.js';
import { updateBot } from '../bots-config-writer.js';

export async function handleSessionRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  if (!url.startsWith('/api/sessions')) return false;

  const { sessionRegistry } = ctx;
  if (!sessionRegistry) {
    jsonResponse(res, 503, { error: 'Session sync not available' });
    return true;
  }

  // GET /api/sessions?botName=X — list sessions for a bot
  if (method === 'GET' && (url.startsWith('/api/sessions?') || url === '/api/sessions')) {
    const params = new URL(url, 'http://localhost').searchParams;
    const botName = params.get('botName');
    if (!botName) {
      jsonResponse(res, 400, { error: 'botName query parameter required' });
      return true;
    }
    const sessions = sessionRegistry.listSessions(botName);
    jsonResponse(res, 200, { sessions });
    return true;
  }

  // GET /api/sessions/:id/messages — get session message history
  const messagesMatch = url.match(/^\/api\/sessions\/([^/]+)\/messages/);
  if (method === 'GET' && messagesMatch) {
    const sessionId = decodeURIComponent(messagesMatch[1]);
    const session = sessionRegistry.getSession(sessionId);
    if (!session) {
      jsonResponse(res, 404, { error: 'Session not found' });
      return true;
    }
    const params = new URL(url, 'http://localhost').searchParams;
    const since = params.get('since') ? Number(params.get('since')) : undefined;
    const messages = sessionRegistry.getMessages(sessionId, since);
    jsonResponse(res, 200, { session, messages });
    return true;
  }

  // POST /api/sessions/:id/adopt — link a new chatId to an existing session
  const adoptMatch = url.match(/^\/api\/sessions\/([^/]+)\/adopt$/);
  if (method === 'POST' && adoptMatch) {
    const sessionId = decodeURIComponent(adoptMatch[1]);
    const body = await parseJsonBody(req);
    const { chatId, platform } = body as { chatId?: string; platform?: string };
    if (!chatId) {
      jsonResponse(res, 400, { error: 'chatId required' });
      return true;
    }
    const claudeSessionId = sessionRegistry.linkChatId(sessionId, chatId, platform);
    if (claudeSessionId === undefined && !sessionRegistry.getSession(sessionId)) {
      jsonResponse(res, 404, { error: 'Session not found' });
      return true;
    }
    // Set in SessionManager so future messages resume the conversation
    if (claudeSessionId) {
      const session = sessionRegistry.getSession(sessionId);
      if (session) {
        const bot = ctx.registry.get(session.botName);
        if (bot) {
          bot.bridge.getSessionManager().setSessionId(chatId, claudeSessionId);
        }
      }
    }
    const history = sessionRegistry.getMessages(sessionId);
    jsonResponse(res, 200, { sessionId, claudeSessionId, history });
    return true;
  }

  // GET /api/sessions/:id — get session detail
  const detailMatch = url.match(/^\/api\/sessions\/([^/]+)$/);
  if (method === 'GET' && detailMatch) {
    const sessionId = decodeURIComponent(detailMatch[1]);
    const session = sessionRegistry.getSession(sessionId);
    if (!session) {
      jsonResponse(res, 404, { error: 'Session not found' });
      return true;
    }
    const links = sessionRegistry.getLinks(sessionId);
    const messages = sessionRegistry.getMessages(sessionId);
    jsonResponse(res, 200, { session, links, messages });
    return true;
  }

  // ─── Local desktop session scanning ───────────────────────────────────────

  // GET /api/sessions/local?dir=/path/to/project — scan local Claude Code desktop sessions
  if (method === 'GET' && url.startsWith('/api/sessions/local')) {
    const params = new URL(url, 'http://localhost').searchParams;
    const dir    = params.get('dir');
    if (dir) {
      const sessions = await scanSessions(dir);
      jsonResponse(res, 200, { dir, sessions });
    } else {
      // List all project directories that have sessions
      const dirs = listProjectDirs();
      jsonResponse(res, 200, { dirs });
    }
    return true;
  }

  // ─── Bot project switching ────────────────────────────────────────────────

  // POST /api/bots/:name/switch — switch a bot to a new project directory + session
  const switchMatch = url.match(/^\/api\/bots\/([^/]+)\/switch$/);
  if (method === 'POST' && switchMatch) {
    const botName = decodeURIComponent(switchMatch[1]);
    const body    = await parseJsonBody(req);
    const { workDir, sessionId, chatId } = body as {
      workDir?:   string;
      sessionId?: string;
      chatId?:    string;
    };

    if (!workDir) {
      jsonResponse(res, 400, { error: 'workDir is required' });
      return true;
    }

    // Verify directory exists
    if (!fs.existsSync(workDir)) {
      jsonResponse(res, 400, { error: `Directory does not exist: ${workDir}` });
      return true;
    }

    const { botsConfigPath, logger } = ctx;
    if (!botsConfigPath) {
      jsonResponse(res, 400, { error: 'Bot CRUD requires BOTS_CONFIG to be set' });
      return true;
    }

    try {
      // 1. Update bots.json — change defaultWorkingDirectory
      const updated = updateBot(botsConfigPath, botName, { defaultWorkingDirectory: workDir });
      if (!updated) {
        jsonResponse(res, 404, { error: `Bot not found in config: ${botName}` });
        return true;
      }
      logger.info({ botName, workDir }, 'Bot config updated for project switch');

      // 2. Write pending-switch file for the target bot
      const dataDir = path.join(os.homedir(), '.metabot', botName);
      fs.mkdirSync(dataDir, { recursive: true });
      const pendingSwitchPath = path.join(dataDir, 'pending-switch.json');

      // Determine chatId: use provided, or find from existing session store
      let targetChatId = chatId;
      if (!targetChatId) {
        const sessionStorePath = path.join(dataDir, `sessions-${botName}.json`);
        if (fs.existsSync(sessionStorePath)) {
          try {
            const store = JSON.parse(fs.readFileSync(sessionStorePath, 'utf-8'));
            // Pick the most recently used chatId
            const entries = Object.entries(store) as Array<[string, { lastUsed: number }]>;
            if (entries.length > 0) {
              entries.sort((a, b) => (b[1].lastUsed || 0) - (a[1].lastUsed || 0));
              targetChatId = entries[0][0];
            }
          } catch { /* ignore parse errors */ }
        }
      }

      // Get recent messages from the session .jsonl if sessionId is provided
      let recentHistory: Array<{ role: string; content: string }> = [];
      if (sessionId) {
        const sessions = await scanSessions(workDir);
        const matched  = sessions.find(s => s.sessionId === sessionId);
        if (matched) {
          recentHistory = matched.recentMessages;
        }
      }

      const switchData = {
        workDir,
        sessionId:    sessionId || null,
        chatId:       targetChatId || null,
        recentHistory,
        timestamp:    Date.now(),
      };
      fs.writeFileSync(pendingSwitchPath, JSON.stringify(switchData, null, 2));
      logger.info({ botName, pendingSwitchPath, sessionId, chatId: targetChatId }, 'Pending switch file written');

      // 3. Clear old session store so it doesn't conflict
      const sessionStorePath = path.join(dataDir, `sessions-${botName}.json`);
      if (fs.existsSync(sessionStorePath) && targetChatId) {
        // Rewrite session store with the new session for the target chatId
        const newStore: Record<string, object> = {};
        if (sessionId) {
          newStore[targetChatId] = {
            sessionId,
            workingDirectory: workDir,
            lastUsed:         Date.now(),
            cumulativeTokens:     0,
            cumulativeCostUsd:    0,
            cumulativeDurationMs: 0,
          };
        }
        fs.writeFileSync(sessionStorePath, JSON.stringify(newStore, null, 2));
        logger.info({ botName, chatId: targetChatId, sessionId }, 'Session store updated with new session');
      }

      // 4. Restart the bot via PM2
      try {
        execSync(`pm2 restart ${botName}`, { timeout: 10000, stdio: 'pipe' });
        logger.info({ botName }, 'Bot restarted via PM2');
      } catch (pmErr: any) {
        logger.warn({ botName, err: pmErr.message }, 'PM2 restart failed — bot may need manual restart');
      }

      jsonResponse(res, 200, {
        botName,
        workDir,
        sessionId: sessionId || null,
        chatId:    targetChatId || null,
        restarted: true,
        message:   `Bot ${botName} switched to ${workDir}` + (sessionId ? ` with session ${sessionId.slice(0, 8)}...` : ' (new session)'),
      });
    } catch (err: any) {
      logger.error({ botName, err: err.message }, 'Project switch failed');
      jsonResponse(res, 500, { error: err.message });
    }
    return true;
  }

  return false;
}
