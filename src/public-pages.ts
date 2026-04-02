import fs from 'fs';
import http from 'http';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';

const PUBLISHED_ROUTE_PREFIX = '/published/';
const SAFE_PUBLISHED_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.html$/;

export function sanitizePublishedSlug(slug: string): string {
  const normalized = slug
    .trim()
    .toLowerCase()
    .replace(/\.html?$/i, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');

  return normalized || 'page';
}

export function buildPublishedFilename(slug: string): string {
  return `${sanitizePublishedSlug(slug)}.html`;
}

export function resolvePublishedPagePath(
  groupFolder: string,
  filename: string,
): string {
  if (!SAFE_PUBLISHED_FILENAME.test(filename)) {
    throw new Error(`Invalid published filename "${filename}"`);
  }

  const publishedDir = path.join(
    resolveGroupFolderPath(groupFolder),
    'published',
  );
  const pagePath = path.resolve(publishedDir, filename);
  const rel = path.relative(publishedDir, pagePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Published page path escapes group directory: ${pagePath}`);
  }

  return pagePath;
}

export function tryServePublishedPage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    return false;
  }

  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (!pathname.startsWith(PUBLISHED_ROUTE_PREFIX)) {
    return false;
  }

  const match = pathname.match(/^\/published\/([^/]+)\/([^/]+\.html)$/);
  if (!match) {
    res.writeHead(404);
    res.end('Not found');
    return true;
  }

  const groupFolder = decodeURIComponent(match[1]);
  const filename = decodeURIComponent(match[2]);

  try {
    const filePath = resolvePublishedPagePath(groupFolder, filename);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return true;
    }

    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
    });
    if (method === 'HEAD') {
      res.end();
    } else {
      res.end(body);
    }
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }

  return true;
}
