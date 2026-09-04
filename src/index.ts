import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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
      --bg: #0f172a;
      --panel: #111827;
      --panel-2: #1f2937;
      --text: #e5e7eb;
      --muted: #9ca3af;
      --accent: #22c55e;
      --border: #334155;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at top, #1e293b, var(--bg) 45%);
      color: var(--text);
    }
    .wrap { max-width: 1200px; margin: 0 auto; padding: 32px 20px 48px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: end; flex-wrap: wrap; }
    h1 { margin: 0; font-size: 28px; }
    .sub { color: var(--muted); margin-top: 8px; }
    .pill {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 8px 12px; border-radius: 999px;
      background: rgba(17,24,39,.7); border: 1px solid var(--border);
      font-size: 14px;
    }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--warning); }
    .dot.open { background: var(--accent); }
    .grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 16px; margin-top: 24px; }
    .card {
      background: rgba(17,24,39,.88);
      border: 1px solid rgba(51,65,85,.9);
      border-radius: 20px;
      padding: 18px;
      box-shadow: 0 20px 40px rgba(0,0,0,.2);
    }
    .span-4 { grid-column: span 4; }
    .span-6 { grid-column: span 6; }
    .span-8 { grid-column: span 8; }
    .span-12 { grid-column: span 12; }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    .value { font-size: 18px; margin-top: 8px; }
    .group-list { display: grid; gap: 12px; }
    .group {
      background: rgba(31,41,55,.7);
      border: 1px solid rgba(51,65,85,.9);
      border-radius: 16px;
      padding: 16px;
    }
    .group h3 { margin: 0 0 8px; font-size: 18px; }
    .meta { color: var(--muted); font-size: 13px; display: flex; flex-wrap: wrap; gap: 12px; }
    .summary { white-space: pre-wrap; margin-top: 12px; line-height: 1.55; color: #dbe4ee; }
    .messages { display: grid; gap: 8px; margin-top: 12px; }
    .msg { padding: 10px 12px; background: rgba(15,23,42,.85); border-radius: 12px; border: 1px solid rgba(51,65,85,.75); }
    .msg small { color: var(--muted); display: block; margin-bottom: 4px; }
    @media (max-width: 900px) {
      .span-4, .span-6, .span-8 { grid-column: span 12; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>Watch Groups WhatsApp</h1>
        <div class="sub">Dashboard local para grupos acompanhados e resumos gerados.</div>
      </div>
      <div class="pill"><span class="dot ${connectionStatus === 'open' ? 'open' : ''}"></span><span id="status">${connectionStatus}</span></div>
    </header>

    <section class="grid">
      <div class="card span-4">
        <div class="label">Grupos acompanhados</div>
        <div class="value" id="watchedCount">${watchedGroups.size}</div>
      </div>
      <div class="card span-4">
        <div class="label">Resumos prontos</div>
        <div class="value" id="summaryCount">${summaryIndex.size}</div>
      </div>
      <div class="card span-4">
        <div class="label">Última atualização</div>
        <div class="value" id="updatedAt">${new Date().toLocaleString('pt-BR')}</div>
      </div>

      <div class="card span-12">
        <div class="label">Grupos</div>
        <div class="group-list" id="groups"></div>
      </div>
    </section>
  </div>

  <script>
    async function refresh() {
      const res = await fetch('/api/state');
      const data = await res.json();
      document.getElementById('status').textContent = data.connectionStatus;
      document.getElementById('watchedCount').textContent = data.watchedCount;
      document.getElementById('summaryCount').textContent = data.groups.filter(g => g.latestSummary).length;
      document.getElementById('updatedAt').textContent = new Date(data.generatedAt).toLocaleString('pt-BR');

      const container = document.getElementById('groups');
      container.innerHTML = '';
      if (!data.groups.length) {
        container.innerHTML = '<div class="group">Nenhum grupo carregado ainda. Espere a conexão com o WhatsApp.</div>';
        return;
      }

      data.groups.forEach((group) => {
        const el = document.createElement('div');
        el.className = 'group';
        const summaryText = group.latestSummary ? escapeHtml(group.latestSummary.preview) : 'Sem resumo ainda.';
        const messagesHtml = group.recentMessages.slice().reverse().map((msg) => {
          return '<div class="msg">' +
            '<small>' + escapeHtml(msg.ts + ' · ' + (msg.senderName || msg.sender || 'unknown')) + '</small>' +
            '<div>' + escapeHtml(msg.text || '[sem texto]') + '</div>' +
          '</div>';
        }).join('');
        el.innerHTML =
          '<h3>' + escapeHtml(group.subject) + '</h3>' +
          '<div class="meta">' +
            '<span>ID: ' + escapeHtml(group.id) + '</span>' +
            '<span>Mensagens recentes: ' + group.recentMessages.length + '</span>' +
            '<span>Resumo: ' + (group.latestSummary ? 'sim' : 'não') + '</span>' +
          '</div>' +
          '<div class="summary">' + summaryText + '</div>' +
          '<div class="messages">' + messagesHtml + '</div>';
        container.appendChild(el);
      });
    }

    function escapeHtml(value) {
      return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
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
