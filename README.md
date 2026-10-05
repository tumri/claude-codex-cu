# codex-computer-use (Claude Code plugin)

Lets Claude Code drive macOS apps through the **Codex/ChatGPT app's Computer Use engine**
(`cua_repl`). The engine sends real clicks, drags, typing and scrolls to an app in the background:
it doesn't move your cursor or steal focus, and it works on canvases where accessibility-only drivers fail.
It's unofficial: it reuses the MCP server that ships inside ChatGPT.app.

## What's inside
| Path | Purpose |
|---|---|
| `bin/codex-cu-launch` | stdio MCP launcher. **Re-resolves the server on every start** (see below) |
| `bin/resolve.js` | JXA resolver: finds the newest `unified-computer-use/<ver>/.mcp.json`, takes the `cua_repl` entry (or any server whose command mentions `cua-repl`), and emits `cd`/`export`/`exec` |
| `bin/codex-cu-doctor` | Health check: resolved definition, runtime, live MCP handshake, tool list |
| `.mcp.json` | Registers the `codex-cu` server → launcher |
| `hooks/approve-elicitation.js` | Elicitation hook: shows the engine's per-app approval as a native macOS dialog (Desktop's Code tab and `-p` otherwise auto-decline it), remembers an Allow per app for the session, and logs every decision |
| `hooks/hooks.json` | Registers the Elicitation hook above, and calls `turn_ended` on Stop / StopFailure / SubagentStop, as Codex does, so the engine releases per-turn state |
| `skills/codex-computer-use/` | Skill: how to drive the engine well. `references/playbook.md` is distilled from about 8,300 real Codex (Sol 6.1) calls |

## Update resilience
- Nothing version-specific is hard-coded. The launcher globs
  `$CODEX_HOME/plugins/cache/*/unified-computer-use/*/.mcp.json`, takes the highest version
  (newest mtime on ties), and falls back to `$CODEX_HOME/.tmp/bundled-marketplaces/*/plugins/unified-computer-use`.
  Command, args, env and cwd are all copied from that file, so new env flags or a moved node runtime are picked up.
- It needs only stock macOS (zsh + `osascript -l JavaScript`). No jq, python or Homebrew node.
- The server key is matched by name or command, so a renamed entry still resolves.
- The skill relies on docs the server sends itself (`cua.rewriteDocumentation()`), so API changes come through automatically.
- Overrides: `CODEX_CU_MCP_JSON=/path/.mcp.json` pins a definition; `CODEX_CU_DRY_RUN=1 bin/codex-cu-launch` prints the resolved launch.

## Requirements
- macOS with the ChatGPT app and its Computer Use feature enabled. This installs
  `~/.codex/computer-use/Codex Computer Use.app` and the `unified-computer-use` Codex plugin.
- The Accessibility and Screen Recording permissions that ChatGPT asks for when you enable Computer Use.
- Nothing else. The plugin runs on stock macOS tools plus the node runtime that ships with ChatGPT.

## Install
The repo is its own marketplace (if it's private, your git credentials need access to it):
```bash
claude plugin marketplace add tumri/claude-codex-cu
claude plugin install codex-computer-use@codex-computer-use --scope user
```
Restart the Claude session so the MCP server, hooks and skill load. In the Desktop app the bundled CLI is at
`~/Library/Application Support/Claude/claude-code/<version>/<hash>/claude.app/Contents/MacOS/claude`,
if `claude` isn't on your PATH.

## Update
Push a change with a bumped `version` in `.claude-plugin/plugin.json`. Then run:
```bash
claude plugin marketplace update codex-computer-use
claude plugin update codex-computer-use@codex-computer-use
```
Restart the session afterwards.

## Uninstall
```bash
claude plugin uninstall codex-computer-use@codex-computer-use --scope user
claude plugin marketplace remove codex-computer-use
rm -rf ~/Library/Caches/codex-computer-use ~/Library/Logs/codex-cu-elicitation.log
```

## Use
Ask Claude to do something in a Mac app, e.g. *"Use Calculator in the background to work out 12 × 12."*
The first time each app is used in a Claude session, a native macOS dialog asks
**"Allow Computer Use to use "<App>"?"**. Approve it within 120s. Clicking Deny, or letting it time out, declines.

The engine asks again before *every* action, and its request has no "remember" option. Codex doesn't
re-prompt, so its client presumably remembers the answer. This hook does the same: once you click Allow for an app, later requests for that
app in the same Claude session are accepted without a dialog. A new app or a new session asks again.
A Deny is never remembered. The hook only answers requests from the `codex-cu` server (verified in the
Desktop Code tab).

- Approvals: `~/Library/Caches/codex-computer-use/approvals-<session>.json` (delete one to revoke; pruned after 7 days)
- Audit log: `~/Library/Logs/codex-cu-elicitation.log`, one line per request with `source` = `dialog` or `remembered`

## Troubleshooting
```bash
~/.claude/plugins/cache/codex-computer-use/codex-computer-use/*/bin/codex-cu-doctor
```
Requires ChatGPT.app with Computer Use enabled (it installs `~/.codex/computer-use/Codex Computer Use.app`)
and the macOS Accessibility and Screen Recording permissions you've already granted it. There's no hover support.
