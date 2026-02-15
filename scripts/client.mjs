#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function parseArgs(argv) {
  const opts = { staged: true, json: false, help: false, dryRun: false, confirmCommit: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }

    if (arg === '--json') {
      opts.json = true;
      continue;
    }

    if (arg === '--unstaged') {
      opts.staged = false;
      continue;
    }

    if (arg === '--repo') {
      opts.repoPath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--base') {
      opts.baseRef = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--max-chars') {
      const value = Number(argv[i + 1]);
      if (!Number.isNaN(value)) {
        opts.maxChars = value;
      }
      i += 1;
      continue;
    }

    if (arg === '--commit-message') {
      opts.commitMessage = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--commit-body') {
      opts.commitBody = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--commit-footer') {
      opts.commitFooter = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--dry-run') {
      opts.dryRun = true;
      continue;
    }

    if (arg === '--confirm-commit') {
      opts.confirmCommit = true;
      continue;
    }
  }

  return opts;
}

function printHelp() {
  console.log(`Usage: npm run client -- [options]

Analyze phase options:
  --repo <path>          Git repository path (default: cwd)
  --unstaged             Analyze working tree diff instead of staged changes
  --base <ref>           Compare <ref>...HEAD instead of staged/unstaged diff
  --max-chars <n>        Max diff characters to analyze

Execute phase options:
  --commit-message <msg> Prepare commit flow with this draft message
  --commit-body <body>   Optional commit body (second -m)
  --commit-footer <ftr>  Optional commit footer (third -m)
  --dry-run              Use git commit --dry-run (with --confirm-commit)
  --confirm-commit       Actually run execute_commit after preview

General:
  --json                 Print full structured JSON output
  -h, --help             Show this help
`);
}

function serverCommand() {
  const distPath = resolve(process.cwd(), 'dist/index.js');
  if (!existsSync(distPath)) {
    throw new Error('dist/index.js not found. Run `npm run build` first.');
  }

  return { command: process.execPath, args: [distPath] };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const spawn = serverCommand();
  const transport = new StdioClientTransport({
    command: spawn.command,
    args: spawn.args,
    stderr: 'pipe'
  });

  const client = new Client({
    name: 'mcp-conventional-commit-cli',
    version: '0.2.0'
  });

  try {
    await client.connect(transport);

    const isExecute = typeof options.commitMessage === 'string' && options.commitMessage.length > 0;
    if (!isExecute) {
      const response = await client.callTool({
          name: 'analyze_diff',
          arguments: {
            repoPath: options.repoPath,
            staged: options.staged,
            baseRef: options.baseRef,
            maxChars: options.maxChars
          }
        });

      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }

      const content = Array.isArray(response.content) ? response.content : [];
      const textOutput = content
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n')
        .trim();

      if (textOutput) {
        console.log(textOutput);
      } else {
        console.log(JSON.stringify(response, null, 2));
      }
      return;
    }

    const analyzeResponse = await client.callTool({
      name: 'analyze_diff',
      arguments: {
        repoPath: options.repoPath,
        staged: options.staged,
        baseRef: options.baseRef,
        maxChars: options.maxChars
      }
    });
    const analyzeStructured = analyzeResponse?.structuredContent ?? {};
    const relatedRecentCommits = Array.isArray(analyzeStructured.relatedRecentCommits) ? analyzeStructured.relatedRecentCommits : [];
    const validateResponse = await client.callTool({
      name: 'validate_tone',
      arguments: {
        repoPath: options.repoPath,
        message: options.commitMessage,
        relatedRecentCommits
      }
    });
    const validateStructured = validateResponse?.structuredContent ?? {};
    const suggestedRewrite = typeof validateStructured.suggestedRewrite === 'string' ? validateStructured.suggestedRewrite : options.commitMessage;
    const applied = Boolean(validateStructured.applied);
    const finalMessage = applied ? suggestedRewrite : options.commitMessage;

    let executeResponse = null;
    if (options.confirmCommit) {
      executeResponse = await client.callTool({
        name: 'execute_commit',
        arguments: {
          repoPath: options.repoPath,
          message: finalMessage,
          body: options.commitBody,
          footer: options.commitFooter,
          dryRun: options.dryRun
        }
      });
    }

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            analyze: analyzeResponse,
            validateTone: validateResponse,
            preview: {
              originalMessage: options.commitMessage,
              finalMessage,
              rewritten: applied,
              canExecute: true,
              executed: Boolean(executeResponse),
              confirmationRequired: !options.confirmCommit
            },
            execute: executeResponse
          },
          null,
          2
        )
      );
      return;
    }

    const toneScore = typeof validateStructured.toneScore === 'number' ? validateStructured.toneScore : null;
    const violations = Array.isArray(validateStructured.violations) ? validateStructured.violations : [];
    const analysisSummary = Array.isArray(analyzeResponse?.content)
      ? analyzeResponse.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n').trim()
      : '';

    if (analysisSummary) {
      console.log(analysisSummary);
      console.log('');
    }

    console.log('Commit message preview:');
    console.log(`- original: ${options.commitMessage}`);
    console.log(`- final:    ${finalMessage}`);
    console.log(`- rewritten: ${applied ? 'yes' : 'no'}`);
    if (toneScore !== null) {
      console.log(`- toneScore: ${toneScore}`);
    }
    if (violations.length > 0) {
      console.log(`- violations: ${violations.join('; ')}`);
    }

    if (!options.confirmCommit) {
      console.log('');
      console.log('No commit executed. Re-run with --confirm-commit to execute this message.');
      return;
    }

    const response = executeResponse ?? {};
    const content = Array.isArray(response.content) ? response.content : [];
    const textOutput = content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n')
      .trim();

    if (textOutput) {
      console.log(textOutput);
    } else {
      console.log(JSON.stringify(response, null, 2));
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Client error: ${message}`);
  process.exit(1);
});
