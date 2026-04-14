import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Boris',
  TRIGGER_PATTERN: /^@Boris\b/i,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({
    TELEGRAM_BOT_TOKEN: 'test-token',
  }),
}));

vi.mock('../transcription.js', () => ({
  transcribeAudio: vi.fn(),
}));

type Handler = (...args: any[]) => any;

const botRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('grammy', () => ({
  Bot: class MockBot {
    handlers = new Map<string, Handler>();
    commandHandlers = new Map<string, Handler>();
    api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 101 }),
      sendPhoto: vi.fn().mockResolvedValue(undefined),
      sendDocument: vi.fn().mockResolvedValue(undefined),
      sendVideo: vi.fn().mockResolvedValue(undefined),
      sendChatAction: vi.fn().mockResolvedValue(true),
    };

    constructor(_token: string, _opts: any) {
      botRef.current = this;
    }

    command(name: string, handler: Handler) {
      this.commandHandlers.set(name, handler);
    }

    on(event: string, handler: Handler) {
      this.handlers.set(event, handler);
    }

    catch = vi.fn();

    start(opts: {
      onStart?: (botInfo: { username: string; id: number }) => void;
    }) {
      opts.onStart?.({ username: 'boris_bot', id: 1 });
    }

    stop = vi.fn();
  },
  InputFile: class MockInputFile {
    constructor(_path: string) {}
  },
}));

import { TelegramChannel, TelegramChannelOpts } from './telegram.js';

function createTestOpts(
  overrides?: Partial<TelegramChannelOpts>,
): TelegramChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'tg:42': {
        name: 'Barcelona',
        folder: 'telegram_barcelona',
        trigger: '@Boris',
        added_at: '2026-04-04T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function currentBot() {
  return botRef.current;
}

function createTextContext(overrides: {
  text?: string;
  threadId?: number;
  reply?: ReturnType<typeof vi.fn>;
}) {
  return {
    chat: { id: 42, type: 'supergroup', title: 'Barcelona' },
    from: { id: 7, first_name: 'Emil', username: 'emil' },
    me: { username: 'boris_bot' },
    message: {
      text: overrides.text ?? 'hello',
      date: 1_712_191_200,
      message_id: 55,
      message_thread_id: overrides.threadId,
      entities: [],
    },
    reply: overrides.reply ?? vi.fn().mockResolvedValue(undefined),
    api: currentBot()?.api,
  };
}

async function triggerTextMessage(ctx: ReturnType<typeof createTextContext>) {
  const handler = currentBot().handlers.get('message:text');
  await handler(ctx);
}

describe('TelegramChannel topics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes a registered topic as its own Telegram JID', async () => {
    const opts = createTestOpts({
      registeredGroups: vi.fn(() => ({
        'tg:42:77': {
          name: 'Barcelona / Contacts',
          folder: 'telegram_barcelona_contacts',
          trigger: '@Boris',
          added_at: '2026-04-04T00:00:00.000Z',
        },
      })),
    });
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    await triggerTextMessage(createTextContext({ threadId: 77 }));

    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:42:77',
      expect.objectContaining({
        chat_jid: 'tg:42:77',
        content: 'hello',
      }),
    );
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'tg:42:77',
      expect.any(String),
      'Barcelona / topic 77',
      'telegram',
      true,
    );
  });

  it('falls back to the base chat only when no scoped topics are registered', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    await triggerTextMessage(createTextContext({ threadId: 77 }));

    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:42',
      expect.objectContaining({
        chat_jid: 'tg:42',
      }),
    );
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'tg:42:77',
      expect.any(String),
      'Barcelona / topic 77',
      'telegram',
      true,
    );
  });

  it('does not leak other topics into the base chat once a scoped topic exists', async () => {
    const opts = createTestOpts({
      registeredGroups: vi.fn(() => ({
        'tg:42': {
          name: 'Barcelona',
          folder: 'telegram_barcelona',
          trigger: '@Boris',
          added_at: '2026-04-04T00:00:00.000Z',
        },
        'tg:42:77': {
          name: 'Barcelona / Contacts',
          folder: 'telegram_barcelona_contacts',
          trigger: '@Boris',
          added_at: '2026-04-04T00:00:00.000Z',
        },
      })),
    });
    const channel = new TelegramChannel('test-token', opts);
    await channel.connect();

    await triggerTextMessage(createTextContext({ threadId: 88 }));

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('sends replies back into the topic encoded in the JID', async () => {
    const channel = new TelegramChannel('test-token', createTestOpts());
    await channel.connect();

    await channel.sendMessage('tg:42:77', 'reply');

    expect(currentBot().api.sendMessage).toHaveBeenCalledWith('42', 'reply', {
      message_thread_id: 77,
      parse_mode: 'Markdown',
    });
  });

  it('sends published URLs with underscores as plain text', async () => {
    const channel = new TelegramChannel('test-token', createTestOpts());
    await channel.connect();

    const url =
      'https://89-167-33-29.sslip.io/published/telegram_spain_tickets/spain-trip-plan.html';

    await channel.sendMessage('tg:42:77', url);

    expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
    expect(currentBot().api.sendMessage).toHaveBeenCalledWith('42', url, {
      message_thread_id: 77,
    });
  });

  it('reports the topic-aware chat id in /chatid', async () => {
    const channel = new TelegramChannel('test-token', createTestOpts());
    await channel.connect();

    const reply = vi.fn().mockResolvedValue(undefined);
    const ctx = createTextContext({ threadId: 77, reply });
    const handler = currentBot().commandHandlers.get('chatid');

    await handler(ctx);

    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining('Chat ID: `tg:42:77`'),
      { parse_mode: 'Markdown' },
    );
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining('Parent Chat ID: `tg:42`'),
      { parse_mode: 'Markdown' },
    );
  });
});
