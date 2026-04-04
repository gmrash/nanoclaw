import fs from 'fs';
import https from 'https';
import path from 'path';
import { Api, Bot, InputFile } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { transcribeAudio } from '../transcription.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

function formatTelegramJid(
  chatId: string | number,
  threadId?: number,
): string {
  const normalizedChatId = String(chatId);
  return threadId
    ? `tg:${normalizedChatId}:${threadId}`
    : `tg:${normalizedChatId}`;
}

function parseTelegramJid(jid: string): {
  chatId: string;
  threadId?: number;
} {
  const parts = jid.split(':');
  if (parts.length < 2 || parts[0] !== 'tg') {
    throw new Error(`Invalid Telegram JID: ${jid}`);
  }

  const chatId = parts[1];
  if (!chatId) {
    throw new Error(`Invalid Telegram JID: ${jid}`);
  }

  if (parts.length === 2) {
    return { chatId };
  }

  if (parts.length === 3) {
    const threadId = Number.parseInt(parts[2], 10);
    if (Number.isNaN(threadId)) {
      throw new Error(`Invalid Telegram topic JID: ${jid}`);
    }
    return { chatId, threadId };
  }

  throw new Error(`Invalid Telegram JID: ${jid}`);
}

function hasTopicRegistrationForChat(
  groups: Record<string, RegisteredGroup>,
  chatId: string | number,
): boolean {
  const prefix = `${formatTelegramJid(chatId)}:`;
  return Object.keys(groups).some((jid) => jid.startsWith(prefix));
}

function resolveInboundTelegramJid(
  groups: Record<string, RegisteredGroup>,
  chatId: string | number,
  threadId?: number,
): {
  baseJid: string;
  topicJid?: string;
  activeJid: string;
  group?: RegisteredGroup;
} {
  const baseJid = formatTelegramJid(chatId);
  if (!threadId) {
    return {
      baseJid,
      activeJid: baseJid,
      group: groups[baseJid],
    };
  }

  const topicJid = formatTelegramJid(chatId, threadId);
  const topicGroup = groups[topicJid];
  if (topicGroup) {
    return {
      baseJid,
      topicJid,
      activeJid: topicJid,
      group: topicGroup,
    };
  }

  if (hasTopicRegistrationForChat(groups, chatId)) {
    return {
      baseJid,
      topicJid,
      activeJid: topicJid,
    };
  }

  return {
    baseJid,
    topicJid,
    activeJid: baseJid,
    group: groups[baseJid],
  };
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<number | null> {
  try {
    const msg = await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
    return msg.message_id;
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    const msg = await api.sendMessage(chatId, text, options);
    return msg.message_id;
  }
}

/** Download a file from a URL into a Buffer. */
function downloadFile(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          downloadFile(res.headers.location!).then(resolve, reject);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  // Track the last message_thread_id only for base-chat fallback registrations.
  private threadIds: Map<string, number> = new Map();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const threadId = ctx.message?.message_thread_id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';
      const topicJid = formatTelegramJid(chatId, threadId);
      const lines = [
        `Chat ID: \`${topicJid}\``,
        `Name: ${chatName}`,
        `Type: ${chatType}`,
      ];
      if (threadId) {
        lines.push(`Parent Chat ID: \`${formatTelegramJid(chatId)}\``);
        lines.push(`Topic Thread ID: ${threadId}`);
      }

      ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const groups = this.opts.registeredGroups();
      const threadId = ctx.message.message_thread_id;
      const { baseJid, topicJid, activeJid, group } = resolveInboundTelegramJid(
        groups,
        ctx.chat.id,
        threadId,
      );
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();

      // Include quoted message context if this is a reply
      const reply = ctx.message.reply_to_message;
      if (reply) {
        const replyText = (reply as any).text || (reply as any).caption || '';
        if (replyText) {
          const replyFrom = (reply as any).from?.first_name || 'Unknown';
          const truncated =
            replyText.length > 300
              ? replyText.slice(0, 300) + '...'
              : replyText;
          content = `[В ответ на сообщение от ${replyFrom}: "${truncated}"]\n${content}`;
        }
      }

      if (threadId) {
        this.threadIds.set(activeJid, threadId);
        if (activeJid === baseJid) {
          this.threadIds.set(baseJid, threadId);
        }
      }
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || activeJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        baseJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );
      if (topicJid) {
        this.opts.onChatMetadata(
          topicJid,
          timestamp,
          `${chatName} / topic ${threadId}`,
          'telegram',
          isGroup,
        );
      }

      // Only deliver full message for registered groups
      if (!group) {
        logger.debug(
          { baseJid, topicJid, activeJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(activeJid, {
        id: msgId,
        chat_jid: activeJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid: activeJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const groups = this.opts.registeredGroups();
      const threadId = ctx.message.message_thread_id;
      const { baseJid, topicJid, activeJid, group } = resolveInboundTelegramJid(
        groups,
        ctx.chat.id,
        threadId,
      );
      if (!group) return;

      if (threadId) {
        this.threadIds.set(activeJid, threadId);
        if (activeJid === baseJid) {
          this.threadIds.set(baseJid, threadId);
        }
      }

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        baseJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      if (topicJid) {
        const chatName = (ctx.chat as any).title || baseJid;
        this.opts.onChatMetadata(
          topicJid,
          timestamp,
          `${chatName} / topic ${threadId}`,
          'telegram',
          isGroup,
        );
      }
      this.opts.onMessage(activeJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: activeJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const threadId = ctx.message.message_thread_id;
      const { activeJid, group } = resolveInboundTelegramJid(
        this.opts.registeredGroups(),
        ctx.chat.id,
        threadId,
      );
      if (!group) return;

      try {
        // Get the largest photo (last in the array)
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1];
        const file = await ctx.api.getFile(largest.file_id);
        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const imageBuffer = await downloadFile(url);

        // Save to group folder
        const photosDir = path.join('groups', group.folder, 'photos');
        fs.mkdirSync(photosDir, { recursive: true });
        const ext = file.file_path?.split('.').pop() || 'jpg';
        const filename = `${Date.now()}.${ext}`;
        const filepath = path.join(photosDir, filename);
        fs.writeFileSync(filepath, imageBuffer);

        const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
        storeNonText(
          ctx,
          `[Photo: /workspace/group/photos/${filename}]${caption}`,
        );
        logger.info(
          { chatJid: activeJid, filename, size: imageBuffer.length },
          'Saved Telegram photo',
        );
      } catch (err) {
        logger.error({ err }, 'Failed to download Telegram photo');
        storeNonText(ctx, '[Photo]');
      }
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', async (ctx) => {
      const { group } = resolveInboundTelegramJid(
        this.opts.registeredGroups(),
        ctx.chat.id,
        ctx.message.message_thread_id,
      );
      if (!group) return;

      try {
        const file = await ctx.getFile();
        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const audioBuffer = await downloadFile(url);
        const transcript = await transcribeAudio(audioBuffer, 'voice.ogg');
        if (transcript) {
          storeNonText(ctx, `[Voice: ${transcript}]`);
        } else {
          storeNonText(ctx, '[Voice message]');
        }
      } catch (err) {
        logger.error({ err }, 'Failed to process Telegram voice message');
        storeNonText(ctx, '[Voice message]');
      }
    });
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', async (ctx) => {
      const threadId = ctx.message.message_thread_id;
      const { activeJid, group } = resolveInboundTelegramJid(
        this.opts.registeredGroups(),
        ctx.chat.id,
        threadId,
      );
      if (!group) return;

      const doc = ctx.message.document;
      const name = doc?.file_name || 'file';

      try {
        const file = await ctx.api.getFile(doc!.file_id);
        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const fileBuffer = await downloadFile(url);

        const docsDir = path.join('groups', group.folder, 'documents');
        fs.mkdirSync(docsDir, { recursive: true });
        const filename = `${Date.now()}_${name}`;
        fs.writeFileSync(path.join(docsDir, filename), fileBuffer);

        const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
        storeNonText(
          ctx,
          `[Document: /workspace/group/documents/${filename}]${caption}`,
        );
        logger.info(
          { chatJid: activeJid, filename, size: fileBuffer.length },
          'Saved Telegram document',
        );
      } catch (err) {
        logger.error({ err }, 'Failed to download Telegram document');
        storeNonText(ctx, `[Document: ${name}]`);
      }
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const { chatId, threadId: jidThreadId } = parseTelegramJid(jid);
      const threadId = jidThreadId ?? this.threadIds.get(jid);
      const sendOpts = threadId ? { message_thread_id: threadId } : {};

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, chatId, text, sendOpts);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            chatId,
            text.slice(i, i + MAX_LENGTH),
            sendOpts,
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendPhoto(
    jid: string,
    photoPath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const { chatId, threadId: jidThreadId } = parseTelegramJid(jid);
      const threadId = jidThreadId ?? this.threadIds.get(jid);
      const sendOpts: Record<string, unknown> = {};
      if (threadId) sendOpts.message_thread_id = threadId;
      if (caption) sendOpts.caption = caption;

      await this.bot.api.sendPhoto(
        chatId,
        new InputFile(photoPath),
        sendOpts,
      );
      logger.info({ jid, photoPath }, 'Telegram photo sent');
    } catch (err) {
      logger.error({ jid, photoPath, err }, 'Failed to send Telegram photo');
    }
  }

  async sendDocument(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const { chatId, threadId: jidThreadId } = parseTelegramJid(jid);
      const threadId = jidThreadId ?? this.threadIds.get(jid);
      const sendOpts: Record<string, unknown> = {};
      if (threadId) sendOpts.message_thread_id = threadId;
      if (caption) sendOpts.caption = caption;

      await this.bot.api.sendDocument(
        chatId,
        new InputFile(filePath),
        sendOpts,
      );
      logger.info({ jid, filePath }, 'Telegram document sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send Telegram document');
    }
  }

  async sendVideo(
    jid: string,
    videoPath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const { chatId, threadId: jidThreadId } = parseTelegramJid(jid);
      const threadId = jidThreadId ?? this.threadIds.get(jid);
      const sendOpts: Record<string, unknown> = {};
      if (threadId) sendOpts.message_thread_id = threadId;
      if (caption) sendOpts.caption = caption;

      await this.bot.api.sendVideo(
        chatId,
        new InputFile(videoPath),
        sendOpts,
      );
      logger.info({ jid, videoPath }, 'Telegram video sent');
    } catch (err) {
      logger.error({ jid, videoPath, err }, 'Failed to send Telegram video');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const { chatId, threadId: jidThreadId } = parseTelegramJid(jid);
      const threadId = jidThreadId ?? this.threadIds.get(jid);
      await this.bot.api.sendChatAction(chatId, 'typing', {
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
