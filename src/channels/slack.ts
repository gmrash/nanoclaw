import fs from 'fs';
import path from 'path';
import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export type SlackChannelOpts = ChannelOpts;

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();

  private opts: SlackChannelOpts;
  private botToken: string;
  private openAIKey: string | undefined;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'OPENAI_API_KEY']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;
    this.botToken = botToken || '';
    this.openAIKey = env.OPENAI_API_KEY;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Auto-register channels when the bot is added
    this.app.event('member_joined_channel', async ({ event }) => {
      if (event.user !== this.botUserId) return;
      const jid = `slack:${event.channel}`;
      const groups = this.opts.registeredGroups();
      if (groups[jid]) return; // already registered

      // Resolve channel name
      let channelName = event.channel;
      try {
        const info = await this.app.client.conversations.info({
          channel: event.channel,
        });
        channelName = info.channel?.name || event.channel;
      } catch {
        // use channel ID as fallback name
      }

      if (this.opts.onAutoRegister) {
        this.opts.onAutoRegister(jid, channelName, 'slack');
        logger.info({ jid, channelName }, 'Auto-registered Slack channel');
      }
    });

    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message' && subtype !== 'file_share')
        return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      const msgFiles = (msg as GenericMessageEvent & { files?: unknown[] })
        .files;
      if (!msg.text && (!msgFiles || msgFiles.length === 0)) return;

      // Threaded replies are flattened into the channel conversation.
      // The agent sees them alongside channel-level messages; responses
      // always go to the channel, not back into the thread.

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text || '';
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
      });

      // Handle file attachments
      const msgAny = msg as GenericMessageEvent & {
        files?: Array<{
          id: string;
          name: string;
          mimetype: string;
          url_private_download?: string;
        }>;
      };
      if (
        msgAny.files &&
        msgAny.files.length > 0 &&
        !isBotMessage &&
        groups[jid]
      ) {
        for (const file of msgAny.files) {
          if (file.url_private_download) {
            try {
              const fileBuffer = await this.downloadSlackFile(
                file.url_private_download,
              );
              const filename = `${Date.now()}_${file.name || 'file'}`;
              let subdir = 'documents';
              let marker = `[Document: /workspace/group/documents/${filename}]`;

              if (file.mimetype?.startsWith('image/')) {
                subdir = 'photos';
                marker = `Image file saved at /workspace/group/photos/${filename}`;
              } else if (file.mimetype?.startsWith('video/')) {
                subdir = 'videos';
                marker = `[Video: /workspace/group/videos/${filename}]`;
              }

              const targetDir = path.join('groups', groups[jid].folder, subdir);
              fs.mkdirSync(targetDir, { recursive: true });
              fs.writeFileSync(path.join(targetDir, filename), fileBuffer);

              let finalContent = marker;
              if (file.mimetype?.startsWith('image/')) {
                const desc = await this.describeImageWithOpenAI(fileBuffer, file.mimetype);
                if (desc) {
                  finalContent = `${marker}\nImage description: ${desc}`;
                }
              }

              this.opts.onMessage(jid, {
                id: `${msg.ts}-file-${file.id}`,
                chat_jid: jid,
                sender: msg.user || '',
                sender_name: senderName,
                content: finalContent,
                timestamp,
                is_from_me: false,
                is_bot_message: false,
              });
              logger.info(
                { jid, filename, size: fileBuffer.length },
                'Saved Slack file',
              );
            } catch (err) {
              logger.error(
                { err, fileId: file.id },
                'Failed to download Slack file',
              );
              this.opts.onMessage(jid, {
                id: `${msg.ts}-file-${file.id}`,
                chat_jid: jid,
                sender: msg.user || '',
                sender_name: senderName,
                content: `[File: ${file.name || 'unknown'}]`,
                timestamp,
                is_from_me: false,
                is_bot_message: false,
              });
            }
          }
        }
      }
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({ channel: channelId, text });
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  async sendPhoto(
    jid: string,
    photoPath: string,
    caption?: string,
  ): Promise<void> {
    await this.uploadFile(jid, photoPath, caption);
  }

  async sendDocument(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    await this.uploadFile(jid, filePath, caption);
  }

  async sendVideo(
    jid: string,
    videoPath: string,
    caption?: string,
  ): Promise<void> {
    await this.uploadFile(jid, videoPath, caption);
  }

  private async describeImageWithOpenAI(
    imageBuffer: Buffer,
    mimeType: string,
  ): Promise<string | null> {
    if (!this.openAIKey) return null;

    try {
      const payload = {
        model: 'gpt-4.1-mini',
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'Опиши изображение по-русски в 3-6 предложениях. Если на изображении есть текст — перепиши его. Будь конкретным и фактическим.',
              },
              {
                type: 'input_image',
                image_url: `data:${mimeType};base64,${imageBuffer.toString('base64')}`,
              },
            ],
          },
        ],
        max_output_tokens: 300,
      };

      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.openAIKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        logger.warn({ status: res.status }, 'OpenAI image description request failed');
        return null;
      }

      const data = (await res.json()) as {
        output?: Array<{
          type?: string;
          content?: Array<{ type?: string; text?: string }>;
        }>;
      };

      const text =
        data.output?.find((item) => item.type === 'message')?.content?.find((c) => c.type === 'output_text')?.text || null;
      return text;
    } catch (err) {
      logger.warn({ err }, 'OpenAI image description failed');
      return null;
    }
  }

  private async uploadFile(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    try {
      await this.app.client.filesUploadV2({
        channel_id: channelId,
        file: filePath,
        filename: path.basename(filePath),
        initial_comment: caption || undefined,
      });
      logger.info({ jid, filePath }, 'Slack file uploaded');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to upload Slack file');
    }
  }

  private async downloadSlackFile(url: string): Promise<Buffer> {
    // Use fetch with Bearer auth; fetch automatically drops auth headers on
    // cross-origin redirects (e.g. to Slack CDN), which is correct behavior.
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.botToken}` },
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} downloading Slack file`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);

    // Sanity check: reject HTML responses (auth failure)
    if (buf.slice(0, 15).toString().includes('<!DOCTYPE')) {
      throw new Error('Got HTML response — Slack auth failed');
    }

    return buf;
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
