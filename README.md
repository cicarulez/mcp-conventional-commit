# mcp-conventional-commit

MCP server for a two-phase Conventional Commit flow:

1. analyze the git diff (`analyze_diff`)
2. execute a commit with an LLM-provided message (`execute_commit`)

## Features

- `analyze_diff`:
- analyzes `git diff` (`--cached` by default)
- returns structured signals for type/scope/subject reasoning
- no final commit message generation

- `execute_commit`:
- runs `git commit -m "<header>"` (and `-m "<body>"` when provided)
- supports `--dry-run` mode
- rejects placeholder values like `<header>`, `<body>`, `<footer>`

## Requirements

- Node.js 18+

## Install

```bash
npm install
npm run build
```

## Run server (stdio)

```bash
npm start
```

## Run local CLI client

```bash
npm run client -- --help
```

Analyze phase examples:

```bash
npm run client --
npm run client -- --unstaged
npm run client -- --base main
npm run client -- --json
```

Execute phase examples:

```bash
npm run client -- --commit-message "feat(api): add token refresh"
npm run client -- --commit-message "feat(api): add token refresh" --commit-body "- add refresh token endpoint\n- update auth middleware"
npm run client -- --commit-message "feat(api)!: add token refresh" --commit-body "- add refresh token endpoint" --commit-footer "BREAKING CHANGE: refresh token format changed"
npm run client -- --commit-message "fix(ui): handle null avatar" --dry-run
```

## CLI options

Analyze:

- `--repo <path>`: git repository path
- `--unstaged`: analyze working tree diff instead of staged diff
- `--base <ref>`: compare `<ref>...HEAD`
- `--max-chars <n>`: max diff chars analyzed

Execute:

- `--commit-message <msg>`: run execute phase
- `--commit-body <body>`: optional commit body
- `--commit-footer <ftr>`: optional commit footer
- `--dry-run`: use `git commit --dry-run`

General:

- `--json`: print full structured result

## Using With Codex

### Generic `mcpServers` JSON style

```json
{
  "mcpServers": {
    "conventional-commit": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-conventional-commit/dist/index.js"]
    }
  }
}
```

### Codex `~/.codex/config.toml` style

```toml
[mcp_servers.conventional_commit]
command = "node"
args = ["/absolute/path/to/mcp-conventional-commit/dist/index.js"]

[mcp_servers.conventional_commit.env]
MCP_TRANSPORT_TYPE = "stdio"
```

Then restart your Codex session so the tools are loaded.

## Recommended Flow (Agent)

The MCP server exposes two tools only:
1. `analyze_diff`
2. `execute_commit`

Recommended agent flow:
1. If (and only if) the task modified files in the target project, call `analyze_diff`.
2. Use MCP analysis (`recommendedTypes`, `scopeCandidates`, `subjectHints`, `stats`, `changedFiles`) as structured context for LLM commit message reasoning.
3. Let the LLM produce the final Conventional Commit message.
4. Call `execute_commit` only with explicit user confirmation or when autonomous commit execution is allowed by policy.
5. Prefer `execute_commit` with `dryRun=true` before real commit in strict/safe workflows.

## MCP Conventional Commit Flow (Example)

```text
# MCP Conventional Commit Flow

Run this flow only after tasks that change files in this project.
Do not run it for Q&A or non-editing tasks.

1. Call `analyze_diff` with:
   - `repoPath`: repository path
   - `staged`: true/false (default true)
   - `baseRef`: optional comparison base
2. Read structured output and use:
   - `recommendedTypes` for commit type candidates
   - `scopeCandidates` for optional scope
   - `subjectHints` for subject candidates
   - `stats` and `changedFiles` for justification
3. Produce final Conventional Commit message in the LLM/client.
4. Call `execute_commit` with:
   - `message`: final commit message
   - `body`: optional commit body
   - `footer`: optional commit footer
   - `dryRun`: true first (recommended), then false if valid

Notes:
- Keep commit message generation in the LLM/client layer.
- Use MCP only for deterministic diff analysis and git commit execution.
```

## Tools

### `analyze_diff`

Input:

```json
{
  "repoPath": "/path/to/project",
  "staged": true,
  "baseRef": "main"
}
```

Output (shape):

```json
{
  "hasChanges": true,
  "scopeCandidates": ["api", "auth"],
  "recommendedTypes": [
    { "type": "feat", "score": 6, "reason": "featureSignals=2, addedFiles=1" }
  ],
  "subjectHints": ["add api support"],
  "stats": {
    "files": 3,
    "additions": 42,
    "deletions": 5,
    "addedFiles": 1,
    "deletedFiles": 0,
    "renamedFiles": 0,
    "hasBreakingHint": false
  },
  "changedFiles": ["src/api/auth.ts", "src/api/token.ts", "README.md"]
}
```

### `execute_commit`

Input:

```json
{
  "repoPath": "/path/to/project",
  "message": "feat(api): add token refresh",
  "body": "- add refresh token endpoint\n- update auth middleware",
  "footer": "Refs: #123",
  "dryRun": true
}
```

Output (shape):

```json
{
  "success": true,
  "dryRun": true,
  "message": "feat(api): add token refresh",
  "body": "- add refresh token endpoint\n- update auth middleware",
  "footer": "Refs: #123",
  "stdout": "...",
  "stderr": "..."
}
```
