#!/usr/bin/env node
/**
 * One Squig companion for the team's canvas, many MCP clients.
 *
 * The first session to start this process launches Squig's own stdio server
 * against docs/wireframes/team.squig.json (or SQUIG_FILE). Later sessions on
 * this machine attach to that companion's loopback MCP instead of launching
 * a second one — a second `mcp` process locks the file.
 *
 * Requires a local Squig checkout in SQUIG_CHECKOUT (Node 24, `pnpm build:local`).
 * Squig publishes no npx package. The editor token stays in the companion
 * file next to the canvas (mode 0600) and is never written here to stdout.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CANVAS = join(REPO_ROOT, 'docs/wireframes/team.squig.json');

/** Homebrew kegs, Apple silicon then Intel. The MCP host is often an older Node. */
export const NODE_24_CANDIDATES = [
  '/opt/homebrew/opt/node@24/bin/node',
  '/usr/local/opt/node@24/bin/node',
];

export function canvasPath() {
  return resolve(process.env.SQUIG_FILE || DEFAULT_CANVAS);
}

export function companionPaths(file) {
  return {
    session: `${file}.companion.json`,
    lock: `${file}.companion.lock`,
  };
}

/** Pull the editor URL Squig prints on stderr. The fragment is the token. */
export function parseEditorLine(text) {
  const match = text.match(/Open canvas: (http:\/\/127\.0\.0\.1:\d+\/\?local=1#token=[^\s]+)/);
  if (!match) return null;
  const editorUrl = match[1];
  const url = new URL(editorUrl);
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  if (!token) return null;
  return { editorUrl, origin: url.origin, token };
}

export function redactEditorUrl(editorUrl) {
  const url = new URL(editorUrl);
  url.hash = '';
  return url.toString();
}

export class LineBuffer {
  constructor() {
    this.buf = '';
  }
  push(chunk) {
    this.buf += chunk.toString('utf8');
    const lines = [];
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      if (line.length) lines.push(line);
    }
    return lines;
  }
}

function readSession(sessionPath) {
  try {
    const data = JSON.parse(readFileSync(sessionPath, 'utf8'));
    if (
      !data ||
      typeof data.pid !== 'number' ||
      typeof data.origin !== 'string' ||
      typeof data.token !== 'string'
    ) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sessionHealthy(session) {
  if (!pidAlive(session.pid)) return false;
  try {
    const res = await fetch(`${session.origin}/api/local/session`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

function tryLock(lockPath) {
  try {
    const fd = openSync(lockPath, 'wx', 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  }
}

function release(file) {
  const { session, lock } = companionPaths(file);
  for (const path of [session, lock]) {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  }
}

export function resolveCheckout(envValue, home, exists) {
  const dirs = [];
  if (envValue) dirs.push(envValue);
  dirs.push(join(home, '.squig', 'src'));
  for (const dir of dirs) {
    const root = resolve(dir);
    const entry = join(root, 'scripts/squig.ts');
    const loader = join(root, 'scripts/register-loader.mjs');
    if (exists(entry) && exists(loader)) return { root, entry, loader };
  }
  return null;
}

export function resolveNodeBinary(envValue, home, execPath, execMajor, exists) {
  if (envValue) return exists(envValue) ? envValue : null;
  // Stay on the Node that launched this process. Spawning a second binary
  // (a Node 24 keg, or ~/.squig/node) is what a sandboxed MCP host rejects,
  // and Squig's MCP server answers on Node 22.
  if (execMajor >= 22 && exists(execPath)) return execPath;
  const candidates = [join(home, '.squig', 'node', 'bin', 'node'), ...NODE_24_CANDIDATES];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

function squigCheckout() {
  return resolveCheckout(process.env.SQUIG_CHECKOUT, homedir(), existsSync);
}

function writeSession(sessionPath, session) {
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, JSON.stringify(session), { mode: 0o600 });
  chmodSync(sessionPath, 0o600);
}

async function waitForCompanion(sessionPath, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const session = readSession(sessionPath);
    if (session && (await sessionHealthy(session))) return session;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function proxyStdio(session) {
  let mcpSession = null;
  const lines = new LineBuffer();
  const write = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const post = async (message) => {
    const headers = {
      Authorization: `Bearer ${session.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (mcpSession) headers['Mcp-Session-Id'] = mcpSession;
    const res = await fetch(`${session.origin}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) mcpSession = sid;
    if (res.status === 202 || res.status === 204) return;
    const type = res.headers.get('content-type') || '';
    const body = await res.text();
    if (!res.ok) {
      write({
        jsonrpc: '2.0',
        id: message.id ?? null,
        error: { code: -32000, message: `squig companion returned ${res.status}` },
      });
      return;
    }
    if (type.includes('text/event-stream')) {
      for (const line of body.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        write(JSON.parse(data));
      }
      return;
    }
    if (body.trim()) write(JSON.parse(body));
  };

  process.stdin.on('data', (chunk) => {
    for (const line of lines.push(chunk)) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      void post(message).catch((err) => {
        write({
          jsonrpc: '2.0',
          id: message.id ?? null,
          error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
        });
      });
    }
  });
  await new Promise((resolve) => {
    process.stdin.on('end', resolve);
    process.stdin.on('close', resolve);
  });
}

function becomeCompanion(checkout, file, node) {
  const { session, lock } = companionPaths(file);
  const child = spawn(
    node,
    [
      '--experimental-strip-types',
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      '--import',
      checkout.loader,
      checkout.entry,
      'mcp',
      file,
    ],
    { cwd: checkout.root, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  child.on('error', (err) => {
    process.stderr.write(`squig: failed to start ${node}: ${err.message}\n`);
    release(file);
    process.exit(1);
  });
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    if (stderr.length < 65_536) stderr += text;
    process.stderr.write(text);
    const parsed = parseEditorLine(stderr);
    if (!parsed || existsSync(session)) return;
    writeSession(session, { pid: child.pid, ...parsed });
    process.stderr.write(`squig: companion up at ${redactEditorUrl(parsed.editorUrl)}\n`);
  });
  const stop = () => {
    release(file);
    if (child.pid && pidAlive(child.pid)) child.kill('SIGTERM');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', () => {
    release(file);
    process.exit(child.exitCode ?? 0);
  });
  // lock is held until exit; touch it so a reader sees the owner pid
  writeFileSync(lock, String(process.pid));
}

function readLockPid(lock) {
  try {
    const pid = Number(readFileSync(lock, 'utf8').trim());
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function follow(sessionPath) {
  const session = await waitForCompanion(sessionPath, 20_000);
  if (!session) {
    process.stderr.write('squig: the companion lock is held but the editor never came up\n');
    process.exit(1);
  }
  await proxyStdio(session);
}

async function main() {
  const file = canvasPath();
  mkdirSync(dirname(file), { recursive: true });
  const { session: sessionPath, lock } = companionPaths(file);

  const existing = readSession(sessionPath);
  if (existing && (await sessionHealthy(existing))) {
    await proxyStdio(existing);
    return;
  }

  const owner = readLockPid(lock);
  if (owner && owner !== process.pid && pidAlive(owner)) {
    await follow(sessionPath);
    return;
  }

  const checkout = squigCheckout();
  if (!checkout) {
    process.stderr.write(
      'squig: no checkout. Set SQUIG_CHECKOUT, or clone https://github.com/pablostanley/squig into ~/.squig/src (Node 24, pnpm install --frozen-lockfile, pnpm build:local)\n',
    );
    process.exit(1);
  }
  const node = resolveNodeBinary(
    process.env.SQUIG_NODE,
    homedir(),
    process.execPath,
    Number(process.versions.node.split('.')[0]),
    existsSync,
  );
  if (!node) {
    process.stderr.write(
      `squig: Squig needs Node 22 or newer. This process is Node ${process.versions.node}. Set SQUIG_NODE to a newer binary.\n`,
    );
    process.exit(1);
  }

  // Stale lock or session from a dead owner. Clear it only after the live-owner check.
  release(file);
  if (!tryLock(lock)) {
    await follow(sessionPath);
    return;
  }
  becomeCompanion(checkout, file, node);
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
