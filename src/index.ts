import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

import { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import Groq from 'groq-sdk';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

type WatchedGroup = {
  id: string;
  subject: string;
};

type NormalizedMessage = {
  id: string;
  ts: string;
  chat: string;
  chatId: string;
  isGroup: boolean;
  sender: string | null;
  senderName: string | null;
  type: string;
  text: string;
  hasMedia: boolean;
  fromMe: boolean;
};

type BufferedMessage = NormalizedMessage;

const rootDir = process.env.DATA_DIR ?? path.resolve('data');
const authDir = process.env.AUTH_DIR ?? path.join(rootDir, 'auth');
const summaryDir = process.env.SUMMARY_DIR ?? path.join(rootDir, 'summaries');
const logFile = process.env.LOG_FILE ?? path.join(rootDir, 'conversas.jsonl');
const summaryFile = process.env.SUMMARY_FILE ?? path.join(rootDir, 'conhecimento.md');
const includeSelf = envFlag('INCLUDE_SELF', true);
const groqApiKey = process.env.GROQ_API_KEY?.trim() ?? '';
const groqModel = process.env.GROQ_MODEL?.trim() || 'openai/gpt-oss-20b';
const summaryIntervalSeconds = numberEnv('SUMMARY_INTERVAL_SECONDS', 300);
const summaryMinMessages = numberEnv('SUMMARY_MIN_MESSAGES', 5);
const dashboardEnabled = envFlag('DASHBOARD_ENABLED', true);
const dashboardPort = numberEnv('DASHBOARD_PORT', 3000);
const dashboardHost = process.env.DASHBOARD_HOST ?? '0.0.0.0';
const nextcloudTalkUrl = process.env.NEXTCLOUD_TALK_URL?.trim().replace(/\/$/, '') ?? '';
const nextcloudTalkBotSecret = process.env.NEXTCLOUD_TALK_BOT_SECRET?.trim() ?? '';
const nextcloudTalkConversationToken = process.env.NEXTCLOUD_TALK_CONVERSATION_TOKEN?.trim() ?? '';
const nextcloudTalkConversationMap = parseTalkConversationMap(process.env.NEXTCLOUD_TALK_CONVERSATION_MAP ?? '');
const nextcloudTalkPublish = envFlag('NEXTCLOUD_TALK_PUBLISH', Boolean(nextcloudTalkUrl));
const groupIds = parseCsv(process.env.GROUP_IDS ?? process.env.GROUP_ID);
const groupNames = parseCsv(process.env.GROUP_NAMES ?? process.env.GROUP_NAME).map((value) => value.toLowerCase());

const logger = pino({ level: 'silent' });
const groq = groqApiKey ? new Groq({ apiKey: groqApiKey }) : null;

const watchedGroups = new Map<string, WatchedGroup>();
const bufferedMessages = new Map<string, BufferedMessage[]>();
const recentMessages = new Map<string, BufferedMessage[]>();
const summaryIndex = new Map<string, SummaryRecord>();
let summaryInProgress = false;
let activeSocket: ReturnType<typeof makeWASocket> | null = null;
let summaryTimer: NodeJS.Timeout | null = null;
let groupsRefreshTimer: NodeJS.Timeout | null = null;
let groupsRefreshBackoffMs = 60_000;
let lastGroupsRefreshAt = 0;
let groupsResolved = false;
let connectionStatus: 'starting' | 'connecting' | 'open' | 'closed' | 'logged_out' = 'starting';
const groupsRefreshMinIntervalMs = numberEnv('GROUPS_REFRESH_MIN_INTERVAL_SECONDS', 900) * 1000;

type SummaryRecord = {
  groupId: string;
  subject: string;
  generatedAt: string;
  messageCount: number;
  filePath: string;
  preview: string;
};

async function main() {
  await ensureDirs();
  await loadExistingSummaries();

  console.log('Starting WhatsApp watcher');
  console.log(`Data dir: ${rootDir}`);
  console.log(`Summary provider: ${resolveSummaryProvider()}`);

  if (dashboardEnabled) {
    startDashboardServer();
  }

  summaryTimer = setInterval(() => {
    if (activeSocket) {
      void flushSummaries(activeSocket);
    }
  }, summaryIntervalSeconds * 1000);
  summaryTimer.unref();

  await connectLoop();
}

async function connectLoop() {
  groupsResolved = false;
  connectionStatus = 'connecting';
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    markOnlineOnConnect: false,
    printQRInTerminal: false,
    syncFullHistory: false,
    browser: ['watch-groups-whatsapp', 'Chrome', '1.0.0'],
  });
  activeSocket = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    if (update.qr) {
      console.log('Scan the QR code below with WhatsApp:');
      qrcode.generate(update.qr, { small: true });
    }

    if (update.connection === 'open') {
      connectionStatus = 'open';
      console.log('WhatsApp connected');
      scheduleWatchedGroupsRefresh(sock, 0, true);
      return;
    }

    if (update.connection === 'close') {
      connectionStatus = (update.lastDisconnect?.error as Boom | undefined)?.output?.statusCode === DisconnectReason.loggedOut
        ? 'logged_out'
        : 'closed';
      const statusCode = (update.lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`Connection closed. Reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(() => {
          void connectLoop();
        }, 5_000);
      } else {
        console.log('Logged out. Remove the auth folder and scan the QR again.');
      }
    }
  });

  sock.ev.on('groups.update', () => {
    scheduleWatchedGroupsRefresh(sock, 60_000, false);
  });

  sock.ev.on('messages.upsert', async (event) => {
    if (event.type !== 'notify' && event.type !== 'append') {
      return;
    }

    for (const message of event.messages) {
      try {
        await handleIncomingMessage(sock, message);
      } catch (error) {
        console.error('Failed to process message:', error);
      }
    }
  });

}

function scheduleWatchedGroupsRefresh(
  sock: ReturnType<typeof makeWASocket>,
  delayMs = 0,
  force = false,
) {
  if (groupsRefreshTimer) {
    clearTimeout(groupsRefreshTimer);
  }

  groupsRefreshTimer = setTimeout(() => {
    void refreshWatchedGroups(sock, force).catch((error) => {
      if (isRateLimitError(error)) {
        const nextDelay = groupsRefreshBackoffMs;
        groupsRefreshBackoffMs = Math.min(groupsRefreshBackoffMs * 2, 30 * 60 * 1000);
        console.error(
          `Failed to refresh watched groups due to rate limit. Retrying in ${Math.round(nextDelay / 1000)}s:`,
          error,
        );
        scheduleWatchedGroupsRefresh(sock, nextDelay, true);
        return;
      }

      console.error('Failed to refresh watched groups:', error);
    });
  }, delayMs);

  groupsRefreshTimer.unref();
}

async function refreshWatchedGroups(sock: ReturnType<typeof makeWASocket>, force = false) {
  const now = Date.now();
  if (!force && lastGroupsRefreshAt > 0 && now - lastGroupsRefreshAt < groupsRefreshMinIntervalMs) {
    console.log(
      `Skipping watched groups refresh; last refresh was ${Math.round((now - lastGroupsRefreshAt) / 1000)}s ago`,
    );
    return;
  }

  const participating = await sock.groupFetchAllParticipating();
  const allGroups = Object.values(participating).map((group: any) => ({
    id: group.id,
    subject: group.subject ?? group.id,
  }));

  watchedGroups.clear();

  const watchAll = groupIds.length === 0 && groupNames.length === 0;

  if (watchAll) {
    for (const group of allGroups) {
      watchedGroups.set(group.id, group);
    }
  } else {
    for (const id of groupIds) {
      const found = allGroups.find((group) => group.id === id);
      watchedGroups.set(id, found ?? { id, subject: id });
    }

    for (const group of allGroups) {
      const normalizedSubject = group.subject.toLowerCase();
      if (groupNames.some((name) => normalizedSubject.includes(name))) {
        watchedGroups.set(group.id, group);
      }
    }
  }

  groupsResolved = true;
  lastGroupsRefreshAt = Date.now();
  groupsRefreshBackoffMs = 60_000;
  console.log(`Watching ${watchedGroups.size} group(s)`);
  for (const group of watchedGroups.values()) {
    console.log(`- ${group.subject} (${group.id})`);
  }
}

function isRateLimitError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('rate-overlimit') || message.includes('429');
}

async function handleIncomingMessage(sock: ReturnType<typeof makeWASocket>, message: any) {
  const remoteJid = message?.key?.remoteJid as string | undefined;
  if (!remoteJid || !remoteJid.endsWith('@g.us')) {
    return;
  }

  if (!includeSelf && message?.key?.fromMe) {
    return;
  }

  if (!groupsResolved) {
    return;
  }

  if (watchedGroups.size > 0 && !watchedGroups.has(remoteJid)) {
    return;
  }

  const normalized = normalizeMessage(message, remoteJid);
  if (!normalized) {
    return;
  }

  await appendJsonLine(logFile, normalized);

  const queue = bufferedMessages.get(remoteJid) ?? [];
  queue.push(normalized);
  bufferedMessages.set(remoteJid, queue);

  const recentQueue = recentMessages.get(remoteJid) ?? [];
  recentQueue.push(normalized);
  while (recentQueue.length > 50) {
    recentQueue.shift();
  }
  recentMessages.set(remoteJid, recentQueue);

  const group = watchedGroups.get(remoteJid);
  const label = group?.subject ?? normalized.chat;
  console.log(`[${label}] ${normalized.senderName ?? normalized.sender ?? 'unknown'}: ${shorten(normalized.text, 120)}`);
}

function normalizeMessage(message: any, remoteJid: string): NormalizedMessage | null {
  const content = unwrapContent(message?.message);
  if (!content) {
    return null;
  }

  const textInfo = extractText(content);
  const timestamp = isoFromMessage(message?.messageTimestamp);
  const sender = (message?.key?.participant as string | undefined) ?? null;
  const senderName = (message?.pushName as string | undefined) ?? null;

  return {
    id: String(message?.key?.id ?? cryptoRandomId()),
    ts: timestamp,
    chat: watchedGroups.get(remoteJid)?.subject ?? remoteJid,
    chatId: remoteJid,
    isGroup: true,
    sender,
    senderName,
    type: textInfo.kind,
    text: textInfo.text,
    hasMedia: textInfo.hasMedia,
    fromMe: Boolean(message?.key?.fromMe),
  };
}

function unwrapContent(message: any): any {
  if (!message) {
    return undefined;
  }

  if (message.ephemeralMessage?.message) {
    return unwrapContent(message.ephemeralMessage.message);
  }

  if (message.viewOnceMessage?.message) {
    return unwrapContent(message.viewOnceMessage.message);
  }

  if (message.viewOnceMessageV2?.message) {
    return unwrapContent(message.viewOnceMessageV2.message);
  }

  return message;
}

function extractText(content: any): { kind: string; text: string; hasMedia: boolean } {
  if (typeof content.conversation === 'string') {
    return { kind: 'conversation', text: content.conversation, hasMedia: false };
  }

  if (typeof content.extendedTextMessage?.text === 'string') {
    return { kind: 'extendedTextMessage', text: content.extendedTextMessage.text, hasMedia: false };
  }

  if (typeof content.imageMessage?.caption === 'string') {
    return { kind: 'imageMessage', text: content.imageMessage.caption, hasMedia: true };
  }

  if (typeof content.videoMessage?.caption === 'string') {
    return { kind: 'videoMessage', text: content.videoMessage.caption, hasMedia: true };
  }

  if (typeof content.documentMessage?.caption === 'string') {
    return { kind: 'documentMessage', text: content.documentMessage.caption, hasMedia: true };
  }

  if (typeof content.buttonsResponseMessage?.selectedDisplayText === 'string') {
    return {
      kind: 'buttonsResponseMessage',
      text: content.buttonsResponseMessage.selectedDisplayText,
      hasMedia: false,
    };
  }

  if (typeof content.listResponseMessage?.singleSelectReply?.selectedRowId === 'string') {
    return {
      kind: 'listResponseMessage',
      text: content.listResponseMessage.singleSelectReply.selectedRowId,
      hasMedia: false,
    };
  }

  if (typeof content.templateButtonReplyMessage?.selectedDisplayText === 'string') {
    return {
      kind: 'templateButtonReplyMessage',
      text: content.templateButtonReplyMessage.selectedDisplayText,
      hasMedia: false,
    };
  }

  if (typeof content.reactionMessage?.text === 'string') {
    return { kind: 'reactionMessage', text: `[reação] ${content.reactionMessage.text}`, hasMedia: false };
  }

  const kind = Object.keys(content)[0] ?? 'unknown';
  return { kind, text: `[${kind}]`, hasMedia: true };
}

async function flushSummaries(sock: ReturnType<typeof makeWASocket>) {
  if (summaryInProgress) {
    return;
  }

  summaryInProgress = true;
  try {
    for (const [groupId, messages] of bufferedMessages.entries()) {
      if (messages.length < summaryMinMessages) {
        continue;
      }

      const group = watchedGroups.get(groupId) ?? { id: groupId, subject: groupId };
      try {
        const summary = await summarizeGroup(group, messages);
        await persistSummary(group, messages, summary);
        await publishSummaryToTalk(group, summary);
        bufferedMessages.delete(groupId);
      } catch (error) {
        console.error(`Summary failed for ${group.subject}:`, error);
      }
    }
  } finally {
    summaryInProgress = false;
  }
}

async function summarizeGroup(group: WatchedGroup, messages: BufferedMessage[]) {
  const transcript = messages
    .map((message, index) => {
      const speaker = message.senderName ?? message.sender ?? 'unknown';
      return `${index + 1}. [${message.ts}] ${speaker}: ${message.text || '[sem texto]'}`;
    })
    .join('\n');

  const prompt = [
    `Grupo: ${group.subject}`,
    `ID: ${group.id}`,
    `Janela: ${messages[0]?.ts} ate ${messages[messages.length - 1]?.ts}`,
    '',
    'Mensagens:',
    transcript,
    '',
    'Escreva em portugues do Brasil, em markdown, com estas secoes:',
    '- Resumo curto',
    '- Decisoes e encaminhamentos',
    '- Pendencias',
    '- Pessoas citadas',
    '- Proximos passos',
    '',
    'Se houver audio, considere o texto transcrito na mensagem. Seja objetivo.',
  ].join('\n');

  const provider = resolveSummaryProvider();
  if (provider === 'groq') {
    if (!groq) {
      return fallbackSummary(group, messages);
    }

    const response = await groq.chat.completions.create({
      model: groqModel,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            'Voce resume conversas de WhatsApp em portugues do Brasil. Preserve nomes, decisoes e pendencias. Nao invente fatos.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    return response.choices[0]?.message?.content?.trim() || fallbackSummary(group, messages);
  }

  return fallbackSummary(group, messages);
}

function fallbackSummary(group: WatchedGroup, messages: BufferedMessage[]) {
  const names = Array.from(
    new Set(
      messages
        .map((message) => message.senderName ?? message.sender)
        .filter((value): value is string => Boolean(value)),
    ),
  );

  return [
    '### Resumo curto',
    'Sem sumarizador configurado. Defina `GROQ_API_KEY` para habilitar a sumarização.',
    '',
    '### Decisoes e encaminhamentos',
    '- Nao disponivel sem modelo de IA.',
    '',
    '### Pendencias',
    '- Nao disponivel sem modelo de IA.',
    '',
    '### Pessoas citadas',
    names.length > 0 ? names.map((name) => `- ${name}`).join('\n') : '- Nenhuma identificada.',
    '',
    '### Proximos passos',
    '- Aguardar o proximo ciclo de resumo.',
    '',
    `- Mensagens analisadas: ${messages.length}`,
    `- Participantes citados: ${names.length > 0 ? names.join(', ') : 'nao identificados'}`,
    `- Intervalo: ${messages[0]?.ts} ate ${messages[messages.length - 1]?.ts}`,
  ].join('\n');
}

async function persistSummary(group: WatchedGroup, messages: BufferedMessage[], summary: string) {
  const stamp = new Date().toISOString();
  const body = [
    `## ${group.subject}`,
    '',
    `- Grupo: ${group.id}`,
    `- Mensagens analisadas: ${messages.length}`,
    `- Gerado em: ${stamp}`,
    '',
    summary.trim(),
    '',
    '---',
    '',
  ].join('\n');

  await appendFile(summaryFile, body, 'utf8');
  const filePath = path.join(summaryDir, `${safeFileName(group.id)}.md`);
  await writeFile(filePath, body, 'utf8');

  summaryIndex.set(group.id, {
    groupId: group.id,
    subject: group.subject,
    generatedAt: stamp,
    messageCount: messages.length,
    filePath,
    preview: buildPreview(body),
  });

  console.log(`Summary written for ${group.subject}`);
}

function parseTalkConversationMap(value: string) {
  const entries: Array<[string, string]> = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf('=');
      return (separator > 0
        ? [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()]
        : ['', '']) as [string, string];
    })
    .filter(([groupId, token]) => Boolean(groupId && token));
  return new Map<string, string>(entries);
}

function getTalkConversationToken(groupId: string) {
  return nextcloudTalkConversationMap.get(groupId) ?? nextcloudTalkConversationToken;
}

async function publishSummaryToTalk(group: WatchedGroup, summary: string) {
  if (!nextcloudTalkPublish || !nextcloudTalkUrl) {
    return;
  }

  const token = getTalkConversationToken(group.id);
  if (!token) {
    return;
  }

  if (!nextcloudTalkBotSecret) {
    console.error('Talk publication skipped: NEXTCLOUD_TALK_BOT_SECRET is missing');
    return;
  }

  const message = [
    `## Resumo do WhatsApp: ${group.subject}`,
    '',
    summary.trim(),
    '',
    `_Gerado automaticamente em ${new Date().toLocaleString('pt-BR')}_`,
  ].join('\n');
  const body = JSON.stringify({ message });
  const random = randomBytes(32).toString('hex');
  const signature = createHmac('sha256', nextcloudTalkBotSecret)
    .update(random + body)
    .digest('hex');

  try {
    const response = await fetch(
      `${nextcloudTalkUrl}/ocs/v2.php/apps/spreed/api/v1/bot/${encodeURIComponent(token)}/message`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'OCS-APIRequest': 'true',
          'X-Nextcloud-Talk-Bot-Random': random,
          'X-Nextcloud-Talk-Bot-Signature': signature,
        },
        body,
      },
    );

    if (!response.ok) {
      console.error(`Talk publication failed for ${group.subject}: HTTP ${response.status} ${await response.text()}`);
      return;
    }

    console.log(`Summary published to Talk for ${group.subject}`);
  } catch (error) {
    console.error(`Talk publication failed for ${group.subject}:`, error);
  }
}

async function appendJsonLine(filePath: string, payload: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

async function ensureDirs() {
  await mkdir(rootDir, { recursive: true });
  await mkdir(authDir, { recursive: true });
  await mkdir(summaryDir, { recursive: true });
}

async function loadExistingSummaries() {
  try {
    const files = await readdir(summaryDir, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.md')) {
        continue;
      }

      const filePath = path.join(summaryDir, file.name);
      const content = await readFile(filePath, 'utf8');
      const record = parseSummaryRecord(content, filePath);
      if (record) {
        summaryIndex.set(record.groupId, record);
      }
    }
  } catch (error) {
    console.error('Failed to load existing summaries:', error);
  }
}

function parseSummaryRecord(content: string, filePath: string): SummaryRecord | null {
  const subject = content.match(/^##\s+(.+)$/m)?.[1]?.trim();
  const groupId = content.match(/^- Grupo:\s+(.+)$/m)?.[1]?.trim();

  if (!subject || !groupId) {
    return null;
  }

  const generatedAt = content.match(/^- Gerado em:\s+(.+)$/m)?.[1]?.trim() ?? new Date().toISOString();
  const messageCount = Number(content.match(/^- Mensagens analisadas:\s+(\d+)$/m)?.[1] ?? '0');
  const preview = buildPreview(content);

  return {
    groupId,
    subject,
    generatedAt,
    messageCount: Number.isFinite(messageCount) ? messageCount : 0,
    filePath,
    preview,
  };
}

function buildPreview(content: string) {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const summaryStart = lines.findIndex((line) => line === '### Resumo curto');
  if (summaryStart >= 0) {
    return lines.slice(summaryStart + 1, summaryStart + 4).join(' ');
  }

  return lines.slice(0, 3).join(' ');
}

function startDashboardServer() {
  const server = http.createServer(async (_req, res) => {
    const requestUrl = new URL(_req.url ?? '/', `http://${_req.headers.host ?? 'localhost'}`);

    if (requestUrl.pathname === '/api/state') {
      const payload = buildDashboardState();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload, null, 2));
      return;
    }

    if (requestUrl.pathname === '/api/summaries') {
      const payload = buildDashboardState().groups.map((group) => ({
        groupId: group.id,
        subject: group.subject,
        summary: group.latestSummary,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload, null, 2));
      return;
    }

    if (requestUrl.pathname !== '/' && requestUrl.pathname !== '/index.html') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderDashboardHtml());
  });

  server.listen(dashboardPort, dashboardHost, () => {
    console.log(`Dashboard: http://${dashboardHost}:${dashboardPort}`);
  });
}

function buildDashboardState() {
  const groupMap = new Map<string, WatchedGroup>();
  for (const group of watchedGroups.values()) {
    groupMap.set(group.id, group);
  }
  for (const record of summaryIndex.values()) {
    if (!groupMap.has(record.groupId)) {
      groupMap.set(record.groupId, { id: record.groupId, subject: record.subject });
    }
  }

  const allGroups = Array.from(groupMap.values());
  const groups = allGroups.map((group) => {
    const recent = recentMessages.get(group.id) ?? [];
    const summary = summaryIndex.get(group.id);
    return {
      id: group.id,
      subject: group.subject,
      recentMessages: recent.slice(-10),
      latestSummary: summary
        ? {
            generatedAt: summary.generatedAt,
            messageCount: summary.messageCount,
            preview: summary.preview,
            filePath: summary.filePath,
          }
        : null,
    };
  });

  return {
    connectionStatus,
    dashboardEnabled,
    watchedCount: watchedGroups.size,
    watchedGroups: allGroups,
    groups,
    generatedAt: new Date().toISOString(),
  };
}

function renderDashboardHtml() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Watch Groups WhatsApp</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #08111f;
      --panel: rgba(10, 17, 31, 0.88);
      --panel-strong: rgba(15, 23, 42, 0.96);
      --panel-soft: rgba(148, 163, 184, 0.08);
      --text: #e2e8f0;
      --muted: #94a3b8;
      --accent: #34d399;
      --accent-2: #60a5fa;
      --border: rgba(148, 163, 184, 0.2);
      --warning: #fbbf24;
      --danger: #fb7185;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(96, 165, 250, 0.2), transparent 32%),
        radial-gradient(circle at top right, rgba(52, 211, 153, 0.16), transparent 28%),
        linear-gradient(180deg, #08111f 0%, #0f172a 100%);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .wrap {
      max-width: 1320px;
      margin: 0 auto;
      padding: 28px 20px 40px;
    }
    .hero {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 20px;
      flex-wrap: wrap;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0;
      font-size: 30px;
      line-height: 1.1;
      letter-spacing: -0.03em;
    }
    .sub {
      margin-top: 10px;
      color: var(--muted);
      max-width: 72ch;
      line-height: 1.5;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      border: 1px solid var(--border);
      background: rgba(15, 23, 42, 0.75);
      border-radius: 999px;
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.18);
    }
    .dot {
      width: 11px;
      height: 11px;
      border-radius: 999px;
      background: var(--warning);
      box-shadow: 0 0 0 4px rgba(251, 191, 36, 0.16);
    }
    .dot.open {
      background: var(--accent);
      box-shadow: 0 0 0 4px rgba(52, 211, 153, 0.16);
    }
    .dot.closed,
    .dot.logged_out {
      background: var(--danger);
      box-shadow: 0 0 0 4px rgba(251, 113, 133, 0.16);
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      margin: 18px 0 14px;
    }
    .toolbar input,
    .toolbar select,
    .toolbar button {
      appearance: none;
      border: 1px solid var(--border);
      background: rgba(15, 23, 42, 0.82);
      color: var(--text);
      border-radius: 14px;
      padding: 12px 14px;
      font: inherit;
      min-height: 46px;
    }
    .toolbar input {
      flex: 1 1 280px;
      min-width: 0;
    }
    .toolbar select {
      flex: 0 0 220px;
    }
    .toolbar button {
      cursor: pointer;
      background: linear-gradient(135deg, rgba(52, 211, 153, 0.18), rgba(96, 165, 250, 0.18));
    }
    .toolbar button:hover {
      border-color: rgba(148, 163, 184, 0.4);
      transform: translateY(-1px);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 16px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 22px;
      padding: 18px;
      box-shadow: 0 24px 50px rgba(0, 0, 0, 0.18);
      backdrop-filter: blur(14px);
    }
    .span-3 { grid-column: span 3; }
    .span-4 { grid-column: span 4; }
    .span-5 { grid-column: span 5; }
    .span-7 { grid-column: span 7; }
    .span-8 { grid-column: span 8; }
    .span-12 { grid-column: span 12; }
    .label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .value {
      margin-top: 8px;
      font-size: 28px;
      font-weight: 700;
      letter-spacing: -0.03em;
    }
    .helper {
      margin-top: 6px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.4;
    }
    .section-title {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-end;
      margin-bottom: 12px;
    }
    .section-title h2 {
      margin: 0;
      font-size: 18px;
      letter-spacing: -0.02em;
    }
    .muted {
      color: var(--muted);
    }
    .summary-list,
    .group-list {
      display: grid;
      gap: 12px;
    }
    .summary-item,
    .group {
      background: var(--panel-strong);
      border: 1px solid rgba(148, 163, 184, 0.18);
      border-radius: 18px;
      padding: 16px;
    }
    .summary-item h3,
    .group h3 {
      margin: 0;
      font-size: 17px;
      line-height: 1.25;
    }
    .summary-meta,
    .meta {
      margin-top: 8px;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      color: var(--muted);
      font-size: 13px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 5px 10px;
      border-radius: 999px;
      background: var(--panel-soft);
    }
    .preview {
      margin-top: 12px;
      white-space: pre-wrap;
      line-height: 1.55;
      color: #dbe4ee;
    }
    .messages {
      display: grid;
      gap: 8px;
      margin-top: 14px;
    }
    .msg {
      padding: 10px 12px;
      border-radius: 14px;
      background: rgba(2, 6, 23, 0.5);
      border: 1px solid rgba(148, 163, 184, 0.16);
    }
    .msg small {
      display: block;
      margin-bottom: 5px;
      color: var(--muted);
    }
    .empty {
      padding: 16px;
      border-radius: 16px;
      background: rgba(2, 6, 23, 0.45);
      border: 1px dashed rgba(148, 163, 184, 0.28);
      color: var(--muted);
    }
    .error {
      border-color: rgba(251, 113, 133, 0.5);
      color: #fecdd3;
    }
    @media (max-width: 1100px) {
      .span-3, .span-4, .span-5, .span-7, .span-8 { grid-column: span 12; }
      .toolbar select { flex: 1 1 220px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <div>
        <h1>Watch Groups WhatsApp</h1>
        <div class="sub">Dashboard da monitoração dos grupos. Use a busca para localizar um grupo, revisar resumos recentes e acompanhar o estado da conexão.</div>
      </div>
      <div class="status">
        <span class="dot ${connectionStatus}"></span>
        <strong id="status">${connectionStatus}</strong>
      </div>
    </div>

    <div class="toolbar">
      <input id="searchInput" type="search" placeholder="Buscar por grupo, ID, mensagem ou resumo" />
      <select id="groupFilter">
        <option value="all">Todos os grupos</option>
        <option value="with-summary">Com resumo</option>
        <option value="without-summary">Sem resumo</option>
        <option value="with-messages">Com mensagens recentes</option>
      </select>
      <button type="button" id="refreshBtn">Atualizar agora</button>
    </div>

    <section class="grid">
      <div class="card span-3">
        <div class="label">Grupos acompanhados</div>
        <div class="value" id="watchedCount">${watchedGroups.size}</div>
        <div class="helper">Total de grupos observados pelo Baileys nesta sessão.</div>
      </div>
      <div class="card span-3">
        <div class="label">Resumos prontos</div>
        <div class="value" id="summaryCount">${summaryIndex.size}</div>
        <div class="helper">Grupos com resumo consolidado disponível.</div>
      </div>
      <div class="card span-3">
        <div class="label">Mensagens recentes</div>
        <div class="value" id="messageCount">0</div>
        <div class="helper">Soma das mensagens visíveis na janela atual.</div>
      </div>
      <div class="card span-3">
        <div class="label">Última atualização</div>
        <div class="value" id="updatedAt">${new Date().toLocaleString('pt-BR')}</div>
        <div class="helper">Horário do último snapshot retornado pelo watcher.</div>
      </div>

      <div class="card span-5">
        <div class="section-title">
          <h2>Resumo do momento</h2>
          <span class="muted" id="summaryWindow"></span>
        </div>
        <div class="summary-list" id="summaryFeed"></div>
      </div>

      <div class="card span-7">
        <div class="section-title">
          <h2>Grupos monitorados</h2>
          <span class="muted" id="visibleCount"></span>
        </div>
        <div class="group-list" id="groups"></div>
      </div>
    </section>
  </div>

  <script>
    const state = {
      data: null,
      search: '',
      filter: 'all',
    };

    const elements = {
      status: document.getElementById('status'),
      watchedCount: document.getElementById('watchedCount'),
      summaryCount: document.getElementById('summaryCount'),
      messageCount: document.getElementById('messageCount'),
      updatedAt: document.getElementById('updatedAt'),
      summaryWindow: document.getElementById('summaryWindow'),
      visibleCount: document.getElementById('visibleCount'),
      summaryFeed: document.getElementById('summaryFeed'),
      groups: document.getElementById('groups'),
      searchInput: document.getElementById('searchInput'),
      groupFilter: document.getElementById('groupFilter'),
      refreshBtn: document.getElementById('refreshBtn'),
    };

    elements.searchInput.addEventListener('input', (event) => {
      state.search = event.target.value.trim().toLowerCase();
      render();
    });

    elements.groupFilter.addEventListener('change', (event) => {
      state.filter = event.target.value;
      render();
    });

    elements.refreshBtn.addEventListener('click', () => {
      void refresh();
    });

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function formatDate(iso) {
      if (!iso) {
        return 'sem data';
      }

      const date = new Date(iso);
      return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('pt-BR');
    }

    function matchesSearch(group) {
      if (!state.search) {
        return true;
      }

      const haystack = [
        group.subject,
        group.id,
        group.latestSummary?.preview ?? '',
        ...(group.recentMessages ?? []).map((message) => message.text ?? ''),
      ].join(' ').toLowerCase();

      return haystack.includes(state.search);
    }

    function matchesFilter(group) {
      if (state.filter === 'with-summary') {
        return Boolean(group.latestSummary);
      }

      if (state.filter === 'without-summary') {
        return !group.latestSummary;
      }

      if (state.filter === 'with-messages') {
        return (group.recentMessages ?? []).length > 0;
      }

      return true;
    }

    function getVisibleGroups() {
      return (state.data?.groups ?? [])
        .filter(matchesSearch)
        .filter(matchesFilter)
        .sort((a, b) => {
          const aAt = a.latestSummary?.generatedAt ?? '';
          const bAt = b.latestSummary?.generatedAt ?? '';
          return bAt.localeCompare(aAt);
        });
    }

    function buildSummaryFeed(groups) {
      const summaries = groups
        .filter((group) => group.latestSummary)
        .sort((a, b) => b.latestSummary.generatedAt.localeCompare(a.latestSummary.generatedAt))
        .slice(0, 6);

      if (!summaries.length) {
        return '<div class="empty">Nenhum resumo disponível ainda. Quando o Groq processar a primeira janela, eles aparecerão aqui.</div>';
      }

      return summaries.map((group) => {
        return [
          '<article class="summary-item">',
          '<h3>' + escapeHtml(group.subject) + '</h3>',
          '<div class="summary-meta">',
          '<span class="pill">ID: ' + escapeHtml(group.id) + '</span>',
          '<span class="pill">' + escapeHtml(formatDate(group.latestSummary.generatedAt)) + '</span>',
          '<span class="pill">Mensagens: ' + group.latestSummary.messageCount + '</span>',
          '</div>',
          '<div class="preview">' + escapeHtml(group.latestSummary.preview || 'Sem preview') + '</div>',
          '</article>',
        ].join('');
      }).join('');
    }

    function buildGroupCard(group) {
      const summaryText = group.latestSummary ? escapeHtml(group.latestSummary.preview) : 'Sem resumo ainda.';
      const messages = (group.recentMessages ?? []).slice(-5).reverse();
      const messagesHtml = messages.length
        ? messages.map((msg) => {
            return '<div class="msg">' +
              '<small>' + escapeHtml(formatDate(msg.ts) + ' · ' + (msg.senderName || msg.sender || 'unknown')) + '</small>' +
              '<div>' + escapeHtml(msg.text || '[sem texto]') + '</div>' +
            '</div>';
          }).join('')
        : '<div class="empty">Sem mensagens recentes nesta janela.</div>';

      return [
        '<article class="group">',
        '<h3>' + escapeHtml(group.subject) + '</h3>',
        '<div class="meta">',
        '<span class="pill">ID: ' + escapeHtml(group.id) + '</span>',
        '<span class="pill">Mensagens: ' + (group.recentMessages ?? []).length + '</span>',
        '<span class="pill">Resumo: ' + (group.latestSummary ? 'sim' : 'não') + '</span>',
        '</div>',
        '<div class="preview">' + summaryText + '</div>',
        '<div class="messages">' + messagesHtml + '</div>',
        '</article>',
      ].join('');
    }

    function render() {
      const data = state.data;
      const groups = getVisibleGroups();
      const totalMessages = groups.reduce((sum, group) => sum + (group.recentMessages ?? []).length, 0);

      elements.groups.innerHTML = '';
      elements.summaryFeed.innerHTML = '';
      elements.visibleCount.textContent = String(groups.length) + ' visíveis';
      elements.messageCount.textContent = String(totalMessages);
      elements.summaryWindow.textContent = data ? String(data.groups.length) + ' carregados' : '';

      if (!data) {
        elements.groups.innerHTML = '<div class="empty">Carregando estado do watcher...</div>';
        elements.summaryFeed.innerHTML = '<div class="empty">Carregando resumos...</div>';
        return;
      }

      elements.status.textContent = data.connectionStatus;
      elements.watchedCount.textContent = String(data.watchedCount ?? 0);
      elements.summaryCount.textContent = String(data.groups.filter((group) => group.latestSummary).length);
      elements.updatedAt.textContent = formatDate(data.generatedAt);

      elements.summaryFeed.innerHTML = buildSummaryFeed(groups);

      if (!groups.length) {
        elements.groups.innerHTML = '<div class="empty">Nenhum grupo corresponde ao filtro atual.</div>';
        return;
      }

      elements.groups.innerHTML = groups.map(buildGroupCard).join('');
    }

    async function refresh() {
      try {
        const res = await fetch('api/state', { cache: 'no-store' });
        if (!res.ok) {
          throw new Error('HTTP ' + res.status);
        }

        state.data = await res.json();
        render();
      } catch (error) {
        state.data = null;
        elements.status.textContent = 'offline';
        elements.groups.innerHTML = '<div class="empty error">Falha ao carregar o dashboard: ' + escapeHtml(error?.message || String(error)) + '</div>';
        elements.summaryFeed.innerHTML = '<div class="empty error">Falha ao carregar os resumos: ' + escapeHtml(error?.message || String(error)) + '</div>';
      }
    }

    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}

function parseCsv(value: string | undefined) {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function envFlag(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value == null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function numberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isoFromMessage(value: unknown) {
  const numeric = Number(value);
  const ms = Number.isFinite(numeric) ? numeric * 1000 : Date.now();
  return new Date(ms).toISOString();
}

function safeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function shorten(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}

function cryptoRandomId() {
  return `msg_${Math.random().toString(36).slice(2, 10)}`;
}

function resolveSummaryProvider() {
  return groqApiKey ? 'groq' : 'fallback';
}

void main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
