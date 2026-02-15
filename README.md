# mcp-conventional-commit

MCP server for a commit-assist flow:

1. analyze the git diff (`analyze_diff`)
2. validate message tone (`validate_tone`)
3. optionally execute a commit (`execute_commit`) only after user confirmation

## Features

- `analyze_diff`:
- analyzes `git diff` (`--cached` by default)
- returns structured signals for type/scope/subject reasoning
- returns `relatedRecentCommits` only when correlation is high enough
- no final commit message generation

- `validate_tone`:
- validates Conventional Commit tone/style
- returns `toneScore`, `violations`, and `suggestedRewrite`
- auto-falls back to recent history if related commits are not provided

- `execute_commit`:
- runs `git commit -m "<header>"` (and `-m "<body>"` when provided)
- auto-stages files from latest `analyze_diff` by default
- supports `--dry-run` mode
- rejects placeholder values like `<header>`, `<body>`, `<footer>`
- returns an error if `autoStageAnalyzed=true` and no prior `analyze_diff` context exists

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
npm run client -- --commit-message "feat(api): add token refresh"                 # preview only
npm run client -- --commit-message "feat(api): add token refresh" --confirm-commit
npm run client -- --commit-message "feat(api): add token refresh" --commit-body "- add refresh token endpoint\n- update auth middleware" --confirm-commit
npm run client -- --commit-message "feat(api)!: add token refresh" --commit-body "- add refresh token endpoint" --commit-footer "BREAKING CHANGE: refresh token format changed" --confirm-commit
npm run client -- --commit-message "fix(ui): handle null avatar" --dry-run --confirm-commit
```

## CLI options

Analyze:

- `--repo <path>`: git repository path
- `--unstaged`: analyze working tree diff instead of staged diff
- `--base <ref>`: compare `<ref>...HEAD`
- `--max-chars <n>`: max diff chars analyzed
- by default untracked files are included in analysis (synthetic diff vs `/dev/null`)

Execute:

- `--commit-message <msg>`: run preview flow (`analyze_diff` + `validate_tone`)
- `--commit-body <body>`: optional commit body
- `--commit-footer <ftr>`: optional commit footer
- `--confirm-commit`: execute commit after preview confirmation
- `--dry-run`: use `git commit --dry-run` (with `--confirm-commit`)

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

The MCP server exposes three tools:
1. `analyze_diff`
2. `validate_tone`
3. `execute_commit`

Recommended agent flow:
1. If (and only if) the task modified files in the target project, call `analyze_diff`.
2. Use MCP analysis (`recommendedTypes`, `scopeCandidates`, `subjectHints`, `stats`, `changedFiles`) as structured context for LLM commit message reasoning.
3. Draft a commit message in the LLM/client.
4. Call `validate_tone` on the draft and apply rewrite only when score is below threshold.
5. Show the final proposed commit message as a preview to the user.
6. Do not auto-run `execute_commit` in the default flow; propose it as an optional next action.
7. If the user chooses to proceed, call `execute_commit` (prefer `dryRun=true` first in strict/safe workflows).

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
   - `relatedRecentCommits` for continuity hints (already filtered by correlation)
   - `stats` and `changedFiles` for justification
3. Produce draft Conventional Commit message in the LLM/client.
4. Call `validate_tone` with:
   - `message`: draft message
   - `relatedRecentCommits`: optional direct pass-through from `analyze_diff`
   - `minToneScore`: optional threshold (default `0.8`)
5. Show the final commit message preview to the user.
6. Add an optional suggested next action such as:
   - `Run execute_commit with this message`
7. Call `execute_commit` only if the user explicitly confirms:
   - `message`: final commit message
   - `body`: optional commit body
   - `footer`: optional commit footer
   - `autoStageAnalyzed`: optional, default `true` (stages analyzed files automatically)
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
  "baseRef": "main",
  "includeUntracked": true
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
  "changedFiles": ["src/api/auth.ts", "src/api/token.ts", "README.md"],
  "relatedRecentCommits": [
    {
      "hash": "a1b2c3d",
      "subject": "feat(api): add auth token decoder",
      "score": 0.78,
      "reason": "fileOverlap=0.67, lexicalSimilarity=0.40, typeMatch=1"
    }
  ]
}
```

### `validate_tone`

Input:

```json
{
  "repoPath": "/path/to/project",
  "message": "feat(api): Add auth refresh flow.",
  "relatedRecentCommits": [
    {
      "hash": "a1b2c3d",
      "subject": "feat(api): add auth token decoder",
      "score": 0.78,
      "reason": "fileOverlap=0.67, lexicalSimilarity=0.40, typeMatch=1"
    }
  ],
  "minToneScore": 0.8
}
```

Output (shape):

```json
{
  "toneScore": 0.75,
  "violations": ["subject should start with lowercase verb", "subject should not end with punctuation"],
  "suggestedRewrite": "feat(api): add auth refresh flow",
  "applied": true
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
  "autoStageAnalyzed": true,
  "dryRun": true
}
```

Output (shape):

```json
{
  "success": true,
  "dryRun": true,
  "autoStageAnalyzed": true,
  "autoStagedFiles": 3,
  "message": "feat(api): add token refresh",
  "body": "- add refresh token endpoint\n- update auth middleware",
  "footer": "Refs: #123",
  "stdout": "...",
  "stderr": "..."
}
```
