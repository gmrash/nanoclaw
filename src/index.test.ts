import { describe, expect, it } from 'vitest';

import { _recoverCursorFromInterruptedRun } from './index.js';

describe('_recoverCursorFromInterruptedRun', () => {
  it('keeps the current cursor when it is not ahead of the stable cursor', () => {
    expect(
      _recoverCursorFromInterruptedRun(
        '2026-04-13T17:18:55.000Z',
        '2026-04-13T17:18:55.000Z',
        undefined,
      ),
    ).toBe('2026-04-13T17:18:55.000Z');
  });

  it('rolls back to the delivered cursor when the stored cursor is ahead', () => {
    expect(
      _recoverCursorFromInterruptedRun(
        '2026-04-13T17:18:55.000Z',
        '2026-04-13T17:18:00.000Z',
        undefined,
      ),
    ).toBe('2026-04-13T17:18:00.000Z');
  });

  it('falls back to the last bot reply when no delivered cursor exists', () => {
    expect(
      _recoverCursorFromInterruptedRun(
        '2026-04-13T17:18:55.000Z',
        undefined,
        '2026-04-13T17:18:00.000Z',
      ),
    ).toBe('2026-04-13T17:18:00.000Z');
  });

  it('rolls back to start when there is no stable cursor to recover from', () => {
    expect(
      _recoverCursorFromInterruptedRun(
        '2026-04-13T17:18:55.000Z',
        undefined,
        undefined,
      ),
    ).toBe('');
  });
});
