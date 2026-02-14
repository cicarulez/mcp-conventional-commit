#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { analyzeDiff } from './conventional.js';

const execFileAsync = promisify(execFile);

const server = new McpServer({
  name: 'mcp-conventional-commit',
  version: '0.2.0'
});

function normalizeRepoPath(repoPath?: string): string {
  return repoPath && repoPath.trim() ? repoPath : process.cwd();
}

function hasPlaceholderText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  // Guard against literal placeholder text accidentally passed by the LLM/client.
  const explicitPlaceholders = new Set([
    '<header>',
    '<subject>',
    '<message>',
    '<body>',
    '<footer>',
    '[header]',
    '[subject]',
    '[message]',
    '[body]',
    '[footer]'
  ]);

  if (explicitPlaceholders.has(normalized)) {
    return true;
  }

  return /<\s*(header|subject|message|body|footer)\s*>/i.test(normalized);
}

async function runGitCommand(repoPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync('git', ['-C', repoPath, ...args], {
    maxBuffer: 5 * 1024 * 1024
  });
  return { stdout, stderr };
}

async function runGitDiff(options: {
  repoPath?: string;
  staged?: boolean;
  baseRef?: string;
  maxChars?: number;
}): Promise<string> {
  const repoPath = normalizeRepoPath(options.repoPath);
  const maxChars = Math.max(500, Math.min(options.maxChars ?? 120000, 300000));

  const args: string[] = ['diff', '--no-color'];

  if (options.baseRef && options.baseRef.trim()) {
    args.push(`${options.baseRef.trim()}...HEAD`);
  } else if (options.staged ?? true) {
    args.push('--cached');
  }

  const { stdout } = await runGitCommand(repoPath, args);
  return stdout.slice(0, maxChars);
}

server.registerTool(
  'analyze_diff',
  {
    description: 'Analyze git diff and return structured signals for LLM-generated Conventional Commit messages.',
    inputSchema: {
      repoPath: z.string().optional().describe('Repository path (default: current working directory).'),
      staged: z.boolean().optional().describe('Use staged diff (--cached). Default true unless baseRef is set.'),
      baseRef: z.string().optional().describe('Optional base ref for comparison (example: main, origin/main, HEAD~1).'),
      maxChars: z.number().int().min(500).max(300000).optional().describe('Max diff characters to analyze.')
    },
    outputSchema: {
      hasChanges: z.boolean(),
      scopeCandidates: z.array(z.string()),
      recommendedTypes: z.array(
        z.object({
          type: z.string(),
          score: z.number(),
          reason: z.string()
        })
      ),
      subjectHints: z.array(z.string()),
      stats: z.object({
        files: z.number(),
        additions: z.number(),
        deletions: z.number(),
        addedFiles: z.number(),
        deletedFiles: z.number(),
        renamedFiles: z.number(),
        hasBreakingHint: z.boolean()
      }),
      changedFiles: z.array(z.string())
    }
  },
  async ({ repoPath, staged, baseRef, maxChars }) => {
    try {
      const diff = await runGitDiff({ repoPath, staged, baseRef, maxChars });

      if (!diff.trim()) {
        const empty = {
          hasChanges: false,
          scopeCandidates: [],
          recommendedTypes: [{ type: 'chore', score: 10, reason: 'No diff detected' }],
          subjectHints: ['update project files'],
          stats: {
            files: 0,
            additions: 0,
            deletions: 0,
            addedFiles: 0,
            deletedFiles: 0,
            renamedFiles: 0,
            hasBreakingHint: false
          },
          changedFiles: []
        };

        return {
          content: [{ type: 'text', text: 'No changes found in selected diff scope.' }],
          structuredContent: empty
        };
      }

      const analysis = analyzeDiff(diff);
      const structuredContent = {
        hasChanges: true,
        scopeCandidates: analysis.scopeCandidates,
        recommendedTypes: analysis.recommendedTypes,
        subjectHints: analysis.subjectHints,
        stats: {
          files: analysis.stats.files.length,
          additions: analysis.stats.additions,
          deletions: analysis.stats.deletions,
          addedFiles: analysis.stats.addedFiles,
          deletedFiles: analysis.stats.deletedFiles,
          renamedFiles: analysis.stats.renamedFiles,
          hasBreakingHint: analysis.stats.hasBreakingHint
        },
        changedFiles: analysis.stats.files
      };

      const textSummary = [
        `Diff analyzed: ${structuredContent.stats.files} files, +${structuredContent.stats.additions}/-${structuredContent.stats.deletions}`,
        `Top type candidates: ${structuredContent.recommendedTypes.map((t) => `${t.type}(${t.score})`).join(', ')}`,
        `Scope candidates: ${structuredContent.scopeCandidates.join(', ') || '(none)'}`,
        `Breaking hint: ${structuredContent.stats.hasBreakingHint ? 'yes' : 'no'}`
      ].join('\n');

      return {
        content: [{ type: 'text', text: textSummary }],
        structuredContent
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Unable to analyze diff: ${reason}` }],
        isError: true
      };
    }
  }
);

server.registerTool(
  'execute_commit',
  {
    description: 'Execute git commit with a provided Conventional Commit message.',
    inputSchema: {
      repoPath: z.string().optional().describe('Repository path (default: current working directory).'),
      message: z.string().min(1).describe('Commit subject/header to use (prepared by the LLM/client).'),
      body: z.string().optional().describe('Optional commit body text (paragraphs or bullet list).'),
      footer: z.string().optional().describe('Optional commit footer (e.g., BREAKING CHANGE, Refs).'),
      dryRun: z.boolean().optional().describe('If true, runs git commit --dry-run without creating a commit.')
    },
    outputSchema: {
      success: z.boolean(),
      dryRun: z.boolean(),
      message: z.string(),
      body: z.string().nullable(),
      footer: z.string().nullable(),
      stdout: z.string(),
      stderr: z.string()
    }
  },
  async ({ repoPath, message, body, footer, dryRun }) => {
    const trimmedMessage = message.trim();
    const trimmedBody = body?.trim();
    const trimmedFooter = footer?.trim();

    if (!trimmedMessage) {
      return {
        content: [{ type: 'text', text: 'Commit message cannot be empty.' }],
        isError: true
      };
    }

    if (hasPlaceholderText(trimmedMessage) || (trimmedBody ? hasPlaceholderText(trimmedBody) : false) || (trimmedFooter ? hasPlaceholderText(trimmedFooter) : false)) {
      return {
        content: [
          {
            type: 'text',
            text: 'Commit message/body/footer contains placeholder text (e.g. <header>, <body>). Provide real content.'
          }
        ],
        isError: true
      };
    }

    const targetRepo = normalizeRepoPath(repoPath);
    const isDryRun = dryRun ?? false;

    try {
      const args = ['commit', '-m', trimmedMessage];
      if (trimmedBody) {
        args.push('-m', trimmedBody);
      }
      if (trimmedFooter) {
        args.push('-m', trimmedFooter);
      }
      if (isDryRun) {
        args.push('--dry-run');
      }

      const { stdout, stderr } = await runGitCommand(targetRepo, args);
      const structuredContent = {
        success: true,
        dryRun: isDryRun,
        message: trimmedMessage,
        body: trimmedBody ?? null,
        footer: trimmedFooter ?? null,
        stdout,
        stderr
      };

      return {
        content: [
          {
            type: 'text',
            text: isDryRun ? 'Dry-run commit executed successfully.' : 'Commit executed successfully.'
          }
        ],
        structuredContent
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Commit execution failed: ${reason}` }],
        isError: true
      };
    }
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('MCP server failed:', error);
  process.exit(1);
});
