import { createReadStream } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { defaultExec, quoteSingle } from './exec.js';
import type { ExecFn } from './exec.js';

/** Binary upload cap (50 MB, Terwo parity). */
const MAX_UPLOAD = 50 * 1024 * 1024;
/** Text-edit file cap (1 MB, Terwo parity). */
const EDIT_MAX = 1024 * 1024;
/** Image preview cap (20 MB, Terwo parity). */
const PREVIEW_MAX = 20 * 1024 * 1024;
/** JSON body caps per route (Terwo `readBody` limits). */
const SMALL_BODY = 1024 * 1024;
const WRITE_BODY = 10 * 1024 * 1024;
const UPLOAD_BODY = MAX_UPLOAD + 1024 * 1024;
/** Archive operation timeout (60 s, Terwo parity). */
const ARCHIVE_TIMEOUT_MS = 60000;

const PREVIEW_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Resolve `rel` inside `root`, rejecting escapes.
 * Lexical only (symlinks not resolved — Terwo parity, known limitation).
 *
 * @throws `Access outside working directory denied` on escape.
 */
export function safePath(root: string, rel: string): string {
  const resolved = resolve(root, rel === '' ? '.' : rel);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error('Access outside working directory denied');
  }
  return resolved;
}

/**
 * Validate a single file/folder segment (no separators, no `.`/`..`/NUL).
 *
 * @throws `Invalid name` on bad input.
 */
export function safeName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('Invalid name');
  const trimmed = name.trim();
  if (
    trimmed === '' ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0')
  ) {
    throw new Error('Invalid name');
  }
  return trimmed;
}

/** Path of `abs` relative to `root` (`''` for root itself). */
export function relOf(root: string, abs: string): string {
  return relative(root, abs);
}

interface FileEntry {
  name: string;
  type: 'dir' | 'file';
  size: number;
  mtime: number;
  /** Octal mode (`0755` style) or `null` when the stat failed. */
  mode: string | null;
}

async function listDir(dir: string): Promise<FileEntry[]> {
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  const out: FileEntry[] = [];
  for (const entry of dirents) {
    const full = join(dir, entry.name);
    let size = 0;
    let mtime = 0;
    let mode: string | null = null;
    try {
      const st = await fsp.stat(full);
      size = st.size;
      mtime = st.mtimeMs;
      mode = (st.mode & 0o777).toString(8).padStart(4, '0');
    } catch {
      // best effort: keep the entry with zeroed stats
    }
    out.push({ name: entry.name, type: entry.isDirectory() ? 'dir' : 'file', size, mtime, mode });
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return out;
}

/** Require a helper binary, with the Store-install hint on absence. */
async function mustBin(exec: ExecFn, bin: 'zip' | 'unzip'): Promise<void> {
  try {
    await exec(`command -v ${bin} >/dev/null 2>&1`, 8000);
  } catch {
    throw new Error(`Package "${bin}" is not installed — install it first via the Store menu`);
  }
}

function strField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

/** Inputs for {@link registerFilesRoutes}. */
export interface FilesOptions {
  /** Top directory the file manager may access (jail root). */
  root: string;
  /** Shell runner for zip/unzip (tests inject fakes). */
  exec?: ExecFn;
}

/**
 * Register the file-manager endpoints (all behind the session gate).
 * Thrown errors propagate to the app error handler (400 `{error}`).
 */
export function registerFilesRoutes(app: FastifyInstance, opts: FilesOptions): void {
  const exec: ExecFn = opts.exec ?? defaultExec;

  app.get('/api/files', async (req) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const dir = safePath(opts.root, strField(query, 'path'));
    return { path: relOf(opts.root, dir), entries: await listDir(dir) };
  });

  app.post('/api/mkdir', { bodyLimit: SMALL_BODY }, async (req) => {
    const body = ((req.body ?? {}) as Record<string, unknown>);
    await fsp.mkdir(join(safePath(opts.root, strField(body, 'path')), safeName(body['name'])), {
      recursive: true,
    });
    return { ok: true };
  });

  app.post('/api/touch', { bodyLimit: SMALL_BODY }, async (req) => {
    const body = ((req.body ?? {}) as Record<string, unknown>);
    const handle = await fsp
      .open(join(safePath(opts.root, strField(body, 'path')), safeName(body['name'])), 'wx')
      .catch(() => null);
    if (handle !== null) await handle.close();
    return { ok: true };
  });

  app.post('/api/rename', { bodyLimit: SMALL_BODY }, async (req) => {
    const body = ((req.body ?? {}) as Record<string, unknown>);
    const dir = safePath(opts.root, strField(body, 'path'));
    await fsp.rename(join(dir, safeName(body['from'])), join(dir, safeName(body['to'])));
    return { ok: true };
  });

  app.post('/api/delete', { bodyLimit: SMALL_BODY }, async (req) => {
    const body = ((req.body ?? {}) as Record<string, unknown>);
    await fsp.rm(join(safePath(opts.root, strField(body, 'path')), safeName(body['name'])), {
      recursive: true,
      force: true,
    });
    return { ok: true };
  });

  app.post('/api/chmod', { bodyLimit: SMALL_BODY }, async (req) => {
    const body = ((req.body ?? {}) as Record<string, unknown>);
    const full = join(safePath(opts.root, strField(body, 'path')), safeName(body['name']));
    const mode = typeof body['mode'] === 'string' ? body['mode'].trim() : '';
    if (!/^[0-7]{3,4}$/.test(mode)) throw new Error('Invalid mode (octal, e.g. 0644)');
    const lst = await fsp.lstat(full).catch(() => null);
    if (lst === null) throw new Error('Path not found');
    // Symlink health stays CAND-014: never chmod through a link
    // (lstat/chmod TOCTOU accepted residual, same class as wave-2 kill).
    if (lst.isSymbolicLink()) throw new Error('Symlinks cannot be chmodded');
    await fsp.chmod(full, Number.parseInt(mode, 8));
    return { ok: true };
  });

  app.post('/api/read', { bodyLimit: SMALL_BODY }, async (req) => {
    const body = ((req.body ?? {}) as Record<string, unknown>);
    const full = join(safePath(opts.root, strField(body, 'path')), safeName(body['name']));
    const st = await fsp.stat(full);
    if (st.size > EDIT_MAX) throw new Error('File too large to edit (max 1 MB)');
    return { ok: true, content: await fsp.readFile(full, 'utf8') };
  });

  app.post('/api/write', { bodyLimit: WRITE_BODY }, async (req) => {
    const body = ((req.body ?? {}) as Record<string, unknown>);
    if (typeof body['content'] !== 'string') throw new Error('Invalid content');
    await fsp.writeFile(
      join(safePath(opts.root, strField(body, 'path')), safeName(body['name'])),
      body['content'],
      'utf8',
    );
    return { ok: true };
  });

  app.post('/api/upload', { bodyLimit: UPLOAD_BODY }, async (req) => {
    const body = ((req.body ?? {}) as Record<string, unknown>);
    const buf = Buffer.from(typeof body['data'] === 'string' ? body['data'] : '', 'base64');
    if (buf.length > MAX_UPLOAD) throw new Error('File too large (max 50 MB)');
    await fsp.writeFile(
      join(safePath(opts.root, strField(body, 'path')), safeName(body['name'])),
      buf,
    );
    return { ok: true, size: buf.length };
  });

  app.get('/api/download', async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const full = join(safePath(opts.root, strField(query, 'path')), safeName(query['name']));
    const st = await fsp.stat(full);
    if (!st.isFile()) throw new Error('Not a file');
    const filename = safeName(query['name']).replace(/"/g, '');
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', st.size);
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(createReadStream(full));
  });

  app.post('/api/files/zip', { bodyLimit: SMALL_BODY }, async (req) => {
    const body = ((req.body ?? {}) as Record<string, unknown>);
    const full = safePath(opts.root, strField(body, 'path'));
    if (full === opts.root) throw new Error('Cannot zip root');
    await mustBin(exec, 'zip');
    await exec(`zip -rq ${quoteSingle(`${full}.zip`)} ${quoteSingle(basename(full))}`, ARCHIVE_TIMEOUT_MS, {
      cwd: dirname(full),
    });
    return { ok: true, zipPath: relOf(opts.root, `${full}.zip`) };
  });

  app.post('/api/files/unzip', { bodyLimit: SMALL_BODY }, async (req) => {
    const body = ((req.body ?? {}) as Record<string, unknown>);
    const full = safePath(opts.root, strField(body, 'path'));
    if (!/\.zip$/i.test(full)) throw new Error('Not a zip file');
    await mustBin(exec, 'unzip');
    await exec(`unzip -o ${quoteSingle(full)} -d ${quoteSingle(dirname(full))}`, ARCHIVE_TIMEOUT_MS);
    return { ok: true };
  });

  app.get('/api/files/preview', async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const full = safePath(opts.root, strField(query, 'path'));
    const mime = PREVIEW_MIME[extname(full).toLowerCase()];
    if (mime === undefined) throw new Error('Preview supports images only');
    const st = await fsp.stat(full);
    if (!st.isFile() || st.size > PREVIEW_MAX) throw new Error('Invalid file');
    reply.header('Content-Type', mime);
    reply.header('Content-Length', st.size);
    return reply.send(createReadStream(full));
  });
}
