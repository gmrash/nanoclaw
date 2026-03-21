/**
 * WhatsApp Relay — tracks outbound conversations to unregistered numbers
 * so incoming replies can be forwarded back to the originating agent container.
 * Persisted in SQLite so relays survive restarts.
 */

import { upsertWaRelay, getWaRelay, deleteWaRelay } from './db.js';
import { logger } from './logger.js';

export interface RelayEntry {
  originGroupFolder: string;
  originGroupJid: string;
}

export function addRelay(targetJid: string, originGroupFolder: string, originGroupJid: string): void {
  upsertWaRelay(targetJid, originGroupFolder, originGroupJid);
  logger.info({ targetJid, originGroupFolder }, 'WA relay registered');
}

export function getRelay(targetJid: string): RelayEntry | undefined {
  const row = getWaRelay(targetJid);
  if (!row) return undefined;
  return {
    originGroupFolder: row.origin_group_folder,
    originGroupJid: row.origin_group_jid,
  };
}

export function removeRelay(targetJid: string): void {
  deleteWaRelay(targetJid);
}
