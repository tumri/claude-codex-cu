// Elicitation hook: the cua_repl engine asks for per-app approval ("Allow Computer Use to use
// "<App>"?") over MCP elicitation. Some Claude Code surfaces (e.g. the Desktop Code tab, headless
// -p) have no UI for elicitations and silently decline, so we put the question to the user in a
// native macOS dialog and return their answer. Requests from other MCP servers are left untouched.
//
// The engine re-asks on every action (empty schema, no "remember" field); Codex's own client
// remembers the answer. We do the same: an Allow is remembered for that exact request (i.e. that
// app) for the rest of the Claude session. Deny / timeout are never remembered.
// JXA: run via `osascript -l JavaScript`, stdin = hook input JSON, stdout = hook output JSON.
ObjC.import('Foundation');

const fm = $.NSFileManager.defaultManager;
const expand = p => $(p).stringByExpandingTildeInPath.js;
const LOG = expand('~/Library/Logs/codex-cu-elicitation.log');
const STATE_DIR = expand('~/Library/Caches/codex-computer-use');
const MAX_STATE_AGE_MS = 7 * 24 * 3600 * 1000;

function readStdin() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
}

function readJSON(path, fallback) {
  try {
    const s = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
    return s.isNil() ? fallback : JSON.parse(s.js);
  } catch (e) { return fallback; }
}

function writeJSON(path, value) {
  fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(STATE_DIR, true, $(), null);
  $(JSON.stringify(value)).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
}

// Drop approval files from sessions not touched in a week.
function pruneState() {
  try {
    const names = ObjC.deepUnwrap(fm.contentsOfDirectoryAtPathError(STATE_DIR, null)) || [];
    for (const n of names) {
      const p = STATE_DIR + '/' + n;
      const mod = ObjC.unwrap(fm.attributesOfItemAtPathError(p, null).fileModificationDate);
      if (Date.now() - mod.getTime() > MAX_STATE_AGE_MS) fm.removeItemAtPathError(p, null);
    }
  } catch (e) {}
}

// Append one JSON line per request for auditing approvals.
function log(entry) {
  try {
    const line = $(JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)) + '\n')
      .dataUsingEncoding($.NSUTF8StringEncoding);
    if (!fm.fileExistsAtPath(LOG)) fm.createFileAtPathContentsAttributes(LOG, $.NSData.data, $());
    const fh = $.NSFileHandle.fileHandleForWritingAtPath(LOG);
    fh.seekToEndOfFile; fh.writeData(line); fh.closeFile;
  } catch (e) {}
}

function ask(message) {
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  try {
    app.activate();
    const r = app.displayDialog(message +
      '\n\nRequested by Claude Code via the Codex Computer Use engine.' +
      '\nAllow applies to this app for the rest of this Claude session.', {
      withTitle: 'Claude · Computer Use',
      buttons: ['Deny', 'Allow'],
      defaultButton: 'Allow',
      cancelButton: 'Deny',
      givingUpAfter: 120,
      withIcon: 'caution',
    });
    return r.buttonReturned === 'Allow' && !r.gaveUp;
  } catch (e) { return false; } // Deny pressed (-128) or dialog failed
}

function run() {
  let input;
  try { input = JSON.parse(readStdin()); } catch (e) { return ''; }
  if (!/codex-cu/.test(input.mcp_server_name || '')) return '';

  const message = input.message || 'Allow Computer Use?';
  const session = String(input.session_id || 'unknown').replace(/[^\w.-]/g, '_');
  const statePath = STATE_DIR + '/approvals-' + session + '.json';
  const approved = readJSON(statePath, []);

  let action, source;
  if (approved.includes(message)) {
    action = 'accept'; source = 'remembered';
  } else {
    action = ask(message) ? 'accept' : 'decline'; source = 'dialog';
    if (action === 'accept') { writeJSON(statePath, approved.concat(message)); pruneState(); }
  }

  log({ session_id: input.session_id, prompt_id: input.prompt_id, message,
        requested_schema: input.requested_schema, action, source });
  const out = { hookSpecificOutput: { hookEventName: 'Elicitation', action } };
  if (action === 'accept') out.hookSpecificOutput.content = {};
  return JSON.stringify(out);
}
