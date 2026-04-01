import fs from 'fs';
import path from 'path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tempGroupsDir = '/tmp/nanoclaw-public-pages-test';

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) =>
    `/tmp/nanoclaw-public-pages-test/${folder}`,
}));

import {
  buildPublishedFilename,
  tryServePublishedPage,
} from './public-pages.js';

function createResponseCapture() {
  const capture: { status?: number; headers?: object; body?: string } = {};
  const res = {
    writeHead: vi.fn((status: number, headers?: object) => {
      capture.status = status;
      capture.headers = headers;
    }),
    end: vi.fn((body?: Buffer | string) => {
      capture.body = Buffer.isBuffer(body) ? body.toString('utf-8') : body;
    }),
  };

  return { capture, res };
}

describe('public-pages', () => {
  beforeAll(() => {
    fs.mkdirSync(path.join(tempGroupsDir, 'demo-group', 'published'), {
      recursive: true,
    });
  });

  afterAll(() => {
    fs.rmSync(tempGroupsDir, { recursive: true, force: true });
  });

  it('builds a stable safe filename from a slug', () => {
    expect(buildPublishedFilename('Sales Dashboard 2026')).toBe(
      'sales-dashboard-2026.html',
    );
  });

  it('serves a published html page', () => {
    const filename = buildPublishedFilename('demo-report');
    const filePath = path.join(tempGroupsDir, 'demo-group', 'published', filename);
    fs.writeFileSync(filePath, '<html><body>demo report</body></html>', 'utf-8');

    const { capture, res } = createResponseCapture();
    const req = {
      method: 'GET',
      url: `/published/demo-group/${filename}`,
    };

    expect(
      tryServePublishedPage(req as never, res as never),
    ).toBe(true);
    expect(capture.status).toBe(200);
    expect(capture.body).toContain('demo report');
  });

  it('returns 404 for a missing page under the published route', () => {
    const { capture, res } = createResponseCapture();
    const req = {
      method: 'GET',
      url: '/published/demo-group/missing.html',
    };

    expect(
      tryServePublishedPage(req as never, res as never),
    ).toBe(true);
    expect(capture.status).toBe(404);
  });
});
