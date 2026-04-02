import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
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
    api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 101 }),
      sendMessageDraft: vi.fn().mockResolvedValue(true),
      sendPhoto: vi.fn().mockResolvedValue(undefined),
      sendDocument: vi.fn().mockResolvedValue(undefined),
      sendVideo: vi.fn().mockResolvedValue(undefined),
      sendChatAction: vi.fn().mockResolvedValue(true),
    };

    constructor(_token: string, _opts: any) {
      botRef.current = this;
    }

    command = vi.fn();

    on(event: string, handler: Handler) {
      this.handlers.set(event, handler);
    }

    catch = vi.fn();

    start(opts: {
      onStart?: (botInfo: { username: string; id: number }) => void;
    }) {
      opts.onStart?.({ username: 'test_bot', id: 1 });
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
        name: 'Test Chat',
        folder: 'test-chat',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function currentBot() {
  return botRef.current;
}

describe('TelegramChannel streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allocates a fresh draft id for each streaming session', async () => {
    const channel = new TelegramChannel('test-token', createTestOpts());
    await channel.connect();

    (channel as any).nextDraftId = 700;

    const first = await channel.startStreaming('tg:42');
    const second = await channel.startStreaming('tg:42');

    expect(first).toBe(700);
    expect(second).toBe(701);
    expect(currentBot().api.sendMessageDraft).toHaveBeenNthCalledWith(
      1,
      42,
      700,
      '▌',
      {},
    );
    expect(currentBot().api.sendMessageDraft).toHaveBeenNthCalledWith(
      2,
      42,
      701,
      '▌',
      {},
    );
  });

  it('finalizes streaming by sending a normal message instead of reusing the draft', async () => {
    const channel = new TelegramChannel('test-token', createTestOpts());
    await channel.connect();

    const finalText = 'one two three four five six';

    await channel.updateStreaming('tg:42', 900, finalText, true);

    const draftCalls = vi.mocked(currentBot().api.sendMessageDraft).mock
      .calls as Array<[number, number, string]>;
    expect(
      draftCalls.some(
        (call: [number, number, string]) => call[2] === finalText,
      ),
    ).toBe(false);
    expect(currentBot().api.sendMessage).toHaveBeenCalledWith(42, finalText, {
      parse_mode: 'Markdown',
    });
  });

  it('preserves the thread id when sending the finalized streaming message', async () => {
    const channel = new TelegramChannel('test-token', createTestOpts());
    await channel.connect();

    (channel as any).threadIds.set('tg:42', 99);

    await channel.updateStreaming('tg:42', 901, 'short reply', true);

    expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
      42,
      'short reply',
      {
        message_thread_id: 99,
        parse_mode: 'Markdown',
      },
    );
  });
});
