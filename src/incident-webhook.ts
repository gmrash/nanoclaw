import { createHmac, timingSafeEqual } from 'crypto';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import {
  getAllRegisteredGroups,
  initDatabase,
  storeChatMetadata,
  storeMessageDirect,
} from './db.js';
import { logger } from './logger.js';

interface FailedCheck {
  check: string;
  status: string;
  detail?: string;
}

interface DailyPortSummary {
  unique_ips_24h?: number;
  traffic_total_24h_bytes?: number;
  traffic_in_24h_bytes?: number;
  traffic_out_24h_bytes?: number;
}

interface IncidentPayload {
  version?: number;
  source?: string;
  event?: string;
  incident_id?: string;
  detected_at?: string;
  resolved_at?: string | null;
  issue_code?: string;
  summary?: string;
  failed_checks?: FailedCheck[];
  host?: {
    domain?: string;
    public_ip?: string;
    remote_host?: string;
    monitor_mode?: string;
  };
  services?: Record<string, string>;
  daily_proxy_summary?: {
    window_seconds?: number;
    coverage_seconds?: number;
    ports?: Record<string, DailyPortSummary>;
  };
  host_metrics?: Record<string, unknown>;
  ports?: Record<string, unknown>;
}

interface WebhookState {
  activeIncidentId: string | null;
  lastOpenedIncidentId: string | null;
  lastResolvedIncidentId: string | null;
  lastOpenedAt: string | null;
  lastResolvedAt: string | null;
}

const WEBHOOK_HOST = process.env.INCIDENT_WEBHOOK_BIND || '0.0.0.0';
const WEBHOOK_PORT = parseInt(process.env.INCIDENT_WEBHOOK_PORT || '8787', 10);
const WEBHOOK_PATH = process.env.INCIDENT_WEBHOOK_PATH || '/hooks/mtproxy';
const WEBHOOK_SECRET = process.env.INCIDENT_WEBHOOK_SECRET || '';
const EXPECTED_SOURCE = process.env.INCIDENT_WEBHOOK_SOURCE || '';
const TARGET_JID = process.env.INCIDENT_TARGET_JID || '';
const SENDER_ID = process.env.INCIDENT_SENDER_ID || 'incident-webhook';
const SENDER_NAME =
  process.env.INCIDENT_SENDER_NAME || 'MTProxy Incident Monitor';
const STATE_FILE = path.join(DATA_DIR, 'incident-webhook-state.json');
const MAX_BODY_BYTES = 256 * 1024;

function loadState(): WebhookState {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<WebhookState>;
    return {
      activeIncidentId: parsed.activeIncidentId || null,
      lastOpenedIncidentId: parsed.lastOpenedIncidentId || null,
      lastResolvedIncidentId: parsed.lastResolvedIncidentId || null,
      lastOpenedAt: parsed.lastOpenedAt || null,
      lastResolvedAt: parsed.lastResolvedAt || null,
    };
  } catch {
    return {
      activeIncidentId: null,
      lastOpenedIncidentId: null,
      lastResolvedIncidentId: null,
      lastOpenedAt: null,
      lastResolvedAt: null,
    };
  }
}

function saveState(state: WebhookState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function json(
  res: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bufferChunk =
      typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    total += bufferChunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error('payload_too_large');
    }
    chunks.push(bufferChunk);
  }
  return Buffer.concat(chunks);
}

function signaturesMatch(provided: string, body: Buffer): boolean {
  if (!WEBHOOK_SECRET) return true;
  const expected = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

function resolveTargetJid(): string {
  if (TARGET_JID) return TARGET_JID;
  const groups = getAllRegisteredGroups();
  const main = Object.entries(groups).find(([, group]) => group.isMain);
  if (!main) {
    throw new Error(
      'INCIDENT_TARGET_JID is not set and no main registered group was found',
    );
  }
  return main[0];
}

function formatBytes(value: number | undefined): string {
  if (!value || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let current = value;
  let idx = 0;
  while (current >= 1024 && idx < units.length - 1) {
    current /= 1024;
    idx += 1;
  }
  return `${current.toFixed(current >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatDailyPortSummary(
  label: string,
  summary?: DailyPortSummary,
): string[] {
  if (!summary) {
    return [`- ${label}: нет данных за сутки`];
  }
  return [
    `- ${label}: уникальных IP за 24ч ${summary.unique_ips_24h ?? 0}`,
    `  трафик за 24ч ${formatBytes(summary.traffic_total_24h_bytes)} (вход ${formatBytes(summary.traffic_in_24h_bytes)}, выход ${formatBytes(summary.traffic_out_24h_bytes)})`,
  ];
}

function buildIncidentMessage(payload: IncidentPayload): string {
  const targetHost =
    payload.host?.remote_host || payload.host?.domain || 'unknown';
  const targetIp = payload.host?.public_ip || 'unknown';
  const coverageSeconds = payload.daily_proxy_summary?.coverage_seconds || 0;
  const coverageMinutes = Math.floor(coverageSeconds / 60);
  const isManualTest = payload.issue_code === 'manual_test';
  const lines = [
    isManualTest
      ? 'Тестовый webhook MTProxy. Это dry-run интеграции, ничего на target host не меняй.'
      : 'Автоматический инцидент MTProxy. Возьми это как задачу на диагностику и remediation.',
    '',
    `Incident ID: ${payload.incident_id || 'unknown'}`,
    `Источник: ${payload.source || 'unknown'}`,
    `Обнаружено: ${payload.detected_at || 'unknown'}`,
    `Issue code: ${payload.issue_code || 'unknown'}`,
    `Target: ${targetHost} (${targetIp})`,
    `Monitor mode: ${payload.host?.monitor_mode || 'unknown'}`,
    '',
    'Сводка монитора:',
    payload.summary || 'summary missing',
    '',
    'Упавшие проверки:',
    ...(payload.failed_checks && payload.failed_checks.length > 0
      ? payload.failed_checks.map(
          (check) =>
            `- ${check.check}: ${check.status}${check.detail ? ` (${check.detail})` : ''}`,
        )
      : ['- нет']),
    '',
    `Статистика за окно мониторинга: ${coverageMinutes}m`,
    ...formatDailyPortSummary(
      'Fake-TLS :443',
      payload.daily_proxy_summary?.ports?.['443'],
    ),
    ...formatDailyPortSummary(
      'Fallback :8443',
      payload.daily_proxy_summary?.ports?.['8443'],
    ),
    '',
    'Доступ к серверу:',
    `ssh -i /workspace/shared-credentials/mtproxy-staticc/id_ed25519 -o StrictHostKeyChecking=accept-new root@${targetIp}`,
    '',
    'Что делать:',
    ...(isManualTest
      ? [
          '1. Проверь, что можешь дотянуться до target host по SSH указанной командой.',
          '2. Ничего не перезапускай и не меняй на сервере.',
          '3. Ответь в этот Telegram-чат коротко, что webhook дошел, SSH доступ есть и remediation pipeline готов.',
        ]
      : [
          '1. Сначала перепроверь текущее состояние сервера: systemctl, ss, journalctl, certbot. Монитор мог поймать уже устаревший срез.',
          '2. Найди root cause минимально инвазивно.',
          '3. Разрешенные безопасные действия: restart mtproxy-443, restart mtproxy-8443, restart/reload nginx, start mtproxy-refresh.service, certbot renew --dry-run для проверки, проверка redirect/firewall.',
          '4. Перезагрузка VPS допустима только если сервисы не поднимаются после точечных фиксов, и только один раз.',
          '5. Не меняй домен, IP, секреты и не переписывай конфиги без явной необходимости для восстановления сервиса.',
          '6. После действий снова перепроверь health.',
          '7. Ответь в этот Telegram-чат коротким отчетом: текущий статус, root cause, что сделал, нужен ли ручной follow-up.',
        ]),
  ];
  return lines.join('\n');
}

function injectIncidentMessage(payload: IncidentPayload): void {
  const chatJid = resolveTargetJid();
  const timestamp = new Date().toISOString();
  storeChatMetadata(chatJid, timestamp, chatJid, 'telegram', true);
  storeMessageDirect({
    id: `incident-${payload.incident_id || Date.now().toString()}`,
    chat_jid: chatJid,
    sender: SENDER_ID,
    sender_name: SENDER_NAME,
    content: buildIncidentMessage(payload),
    timestamp,
    is_from_me: false,
    is_bot_message: false,
  });
}

function handleOpened(
  payload: IncidentPayload,
  state: WebhookState,
): { statusCode: number; body: Record<string, unknown> } {
  const incidentId = payload.incident_id || '';
  if (!incidentId) {
    return {
      statusCode: 400,
      body: { ok: false, error: 'missing incident_id' },
    };
  }

  if (state.lastOpenedIncidentId === incidentId) {
    return {
      statusCode: 200,
      body: { ok: true, duplicate: true, incident_id: incidentId },
    };
  }

  if (state.activeIncidentId && state.activeIncidentId !== incidentId) {
    return {
      statusCode: 202,
      body: {
        ok: true,
        ignored: true,
        reason: 'another incident is already active',
        active_incident_id: state.activeIncidentId,
        incident_id: incidentId,
      },
    };
  }

  injectIncidentMessage(payload);
  state.activeIncidentId = incidentId;
  state.lastOpenedIncidentId = incidentId;
  state.lastOpenedAt = new Date().toISOString();
  saveState(state);
  logger.info({ incidentId }, 'Incident injected into NanoClaw main chat');
  return {
    statusCode: 202,
    body: { ok: true, accepted: true, incident_id: incidentId },
  };
}

function handleResolved(
  payload: IncidentPayload,
  state: WebhookState,
): { statusCode: number; body: Record<string, unknown> } {
  const incidentId = payload.incident_id || '';
  if (!incidentId) {
    return {
      statusCode: 400,
      body: { ok: false, error: 'missing incident_id' },
    };
  }

  if (state.lastResolvedIncidentId === incidentId) {
    return {
      statusCode: 200,
      body: { ok: true, duplicate: true, incident_id: incidentId },
    };
  }

  if (state.activeIncidentId === incidentId) {
    state.activeIncidentId = null;
  }
  state.lastResolvedIncidentId = incidentId;
  state.lastResolvedAt = new Date().toISOString();
  saveState(state);
  logger.info({ incidentId }, 'Incident marked resolved');
  return {
    statusCode: 200,
    body: { ok: true, resolved: true, incident_id: incidentId },
  };
}

async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, { ok: true });
    return;
  }

  if (req.method !== 'POST' || req.url !== WEBHOOK_PATH) {
    json(res, 404, { ok: false, error: 'not found' });
    return;
  }

  let body: Buffer;
  try {
    body = await readBody(req);
  } catch (err) {
    const error = err instanceof Error ? err.message : 'invalid_body';
    json(res, error === 'payload_too_large' ? 413 : 400, {
      ok: false,
      error,
    });
    return;
  }

  const providedSignature =
    typeof req.headers['x-incident-signature-256'] === 'string'
      ? req.headers['x-incident-signature-256']
      : '';
  if (WEBHOOK_SECRET && !signaturesMatch(providedSignature, body)) {
    json(res, 401, { ok: false, error: 'bad signature' });
    return;
  }

  let payload: IncidentPayload;
  try {
    payload = JSON.parse(body.toString('utf-8')) as IncidentPayload;
  } catch {
    json(res, 400, { ok: false, error: 'invalid json' });
    return;
  }

  if (EXPECTED_SOURCE && payload.source !== EXPECTED_SOURCE) {
    json(res, 403, { ok: false, error: 'unexpected source' });
    return;
  }

  const event =
    payload.event ||
    (typeof req.headers['x-incident-event'] === 'string'
      ? req.headers['x-incident-event']
      : '');

  if (event !== 'incident_opened' && event !== 'incident_resolved') {
    json(res, 400, { ok: false, error: 'unsupported event' });
    return;
  }

  const state = loadState();
  const result =
    event === 'incident_opened'
      ? handleOpened(payload, state)
      : handleResolved(payload, state);
  json(res, result.statusCode, result.body);
}

async function main(): Promise<void> {
  initDatabase();
  resolveTargetJid();

  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      logger.error({ err }, 'Incident webhook handler failed');
      json(res, 500, { ok: false, error: 'internal error' });
    });
  });

  server.listen(WEBHOOK_PORT, WEBHOOK_HOST, () => {
    logger.info(
      { host: WEBHOOK_HOST, port: WEBHOOK_PORT, path: WEBHOOK_PATH },
      'Incident webhook receiver started',
    );
  });

  const shutdown = () => {
    logger.info('Incident webhook receiver stopping');
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start incident webhook receiver');
  process.exit(1);
});
