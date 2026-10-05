// Resolves the Codex/ChatGPT "cua_repl" MCP server definition at launch time and
// prints a zsh snippet (cd / export / exec) for bin/codex-cu-launch to eval.
// JXA (osascript -l JavaScript) so it needs nothing beyond stock macOS.
//
// Discovery order:
//   1. $CODEX_CU_MCP_JSON                         explicit .mcp.json override
//   2. $CODEX_HOME/plugins/cache/*/unified-computer-use/<version>/.mcp.json
//      (any marketplace, highest version wins; falls back to newest mtime on ties)
//   3. $CODEX_HOME/.tmp/bundled-marketplaces/*/plugins/unified-computer-use/.mcp.json
ObjC.import('Foundation');

const fm = $.NSFileManager.defaultManager;
const ENV = ObjC.deepUnwrap($.NSProcessInfo.processInfo.environment);
const env = (k) => ENV[k] || '';
const HOME = env('HOME');
const CODEX_HOME = env('CODEX_HOME') || HOME + '/.codex';

function ls(dir) {
  const r = fm.contentsOfDirectoryAtPathError(dir, null);
  return (r && ObjC.deepUnwrap(r)) || [];
}
function exists(p) { return fm.fileExistsAtPath(p); }
function read(p) { return ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null)); }
function mtime(p) {
  const a = fm.attributesOfItemAtPathError(p, null);
  return a ? a.fileModificationDate.timeIntervalSince1970 : 0;
}
function cmpVersion(a, b) {
  const pa = a.split(/[.\-+]/), pb = b.split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '', y = pb[i] ?? '';
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (+x !== +y) return +x - +y; }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function candidates() {
  const out = [];
  const override = env('CODEX_CU_MCP_JSON');
  if (override) return exists(override) ? [{ path: override, version: 'override' }] : [];

  const cache = CODEX_HOME + '/plugins/cache';
  for (const mkt of ls(cache)) {
    const base = `${cache}/${mkt}/unified-computer-use`;
    for (const ver of ls(base)) {
      const p = `${base}/${ver}/.mcp.json`;
      if (exists(p)) out.push({ path: p, version: ver });
    }
  }
  out.sort((a, b) => cmpVersion(b.version, a.version) || mtime(b.path) - mtime(a.path));

  const bundled = CODEX_HOME + '/.tmp/bundled-marketplaces';
  for (const mkt of ls(bundled)) {
    const p = `${bundled}/${mkt}/plugins/unified-computer-use/.mcp.json`;
    if (exists(p)) out.push({ path: p, version: 'bundled' });
  }
  return out;
}

function pickServer(cfg) {
  const servers = cfg.mcpServers || cfg;
  if (servers.cua_repl) return servers.cua_repl;
  for (const k of Object.keys(servers)) {
    const s = servers[k];
    if (s && JSON.stringify([s.command, s.args]).includes('cua-repl')) return s;
  }
  return null;
}

const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

function run() {
  const errors = [];
  for (const c of candidates()) {
    let server;
    try { server = pickServer(JSON.parse(read(c.path))); }
    catch (e) { errors.push(`${c.path}: ${e}`); continue; }
    if (!server || !server.command) { errors.push(`${c.path}: no cua_repl server`); continue; }
    const dir = c.path.replace(/\/[^/]+$/, '');
    const abs = (p) => p.startsWith('/') ? p : `${dir}/${p}`;
    const command = server.command.includes('/') ? abs(server.command) : server.command;
    if (command.startsWith('/') && !exists(command)) { errors.push(`${c.path}: missing ${command}`); continue; }

    const lines = [`export CODEX_CU_RESOLVED=${q(c.path)}`];
    if (server.cwd) lines.push(`cd ${q(abs(server.cwd))} || exit 1`);
    for (const [k, v] of Object.entries(server.env || {})) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) lines.push(`export ${k}=${q(v)}`);
    }
    lines.push(`exec ${[command, ...(server.args || [])].map(q).join(' ')}`);
    return lines.join('\n');
  }
  const msg = errors.length ? errors.join('\n') : `no unified-computer-use .mcp.json found under ${CODEX_HOME}`;
  return `echo ${q('codex-cu: ' + msg + '\nIs the ChatGPT/Codex app installed with Computer Use enabled?')} >&2; exit 1`;
}

run();
