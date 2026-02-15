#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { analyzeDiff, findRelatedRecentCommits, isLikelyNoiseCommit, validateTone, type RecentCommitContext } from './conventional.js';

const execFileAsync = promisify(execFile);

const server = new McpServer({
  name: 'mcp-conventional-commit',
  version: '0.2.0'
});

const analyzedFilesByRepo = new Map<string, string[]>();

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
  includeUntracked?: boolean;
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
  let diff = stdout;

  const includeUntracked = options.includeUntracked ?? true;
  if (includeUntracked) {
    const untracked = await runUntrackedDiff(repoPath);
    if (untracked) {
      diff = `${diff}\n${untracked}`;
    }
  }

  return diff.slice(0, maxChars);
}

async function runGitDiffNoIndex(repoPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
      maxBuffer: 5 * 1024 * 1024
    });
    return stdout;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: number }).code === 1 && 'stdout' in error) {
      return String((error as { stdout?: string }).stdout ?? '');
    }
    throw error;
  }
}

async function runUntrackedDiff(repoPath: string): Promise<string> {
  const { stdout } = await runGitCommand(repoPath, ['ls-files', '--others', '--exclude-standard']);
  const untrackedFiles = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (untrackedFiles.length === 0) {
    return '';
  }

  const parts: string[] = [];
  for (const file of untrackedFiles) {
    const patch = await runGitDiffNoIndex(repoPath, ['diff', '--no-color', '--no-index', '--', '/dev/null', file]);
    if (patch.trim()) {
      parts.push(patch);
    }
  }

  return parts.join('\n');
}

function parseRecentCommitRecord(record: string): RecentCommitContext | null {
  if (!record.trim()) {
    return null;
  }

  const lines = record.split('\n');
  const header = lines.shift() ?? '';
  const [hash, subject] = header.split('\x1f');

  if (!hash?.trim() || !subject?.trim()) {
    return null;
  }

  let additions = 0;
  let deletions = 0;
  const files: string[] = [];

  for (const line of lines) {
    const match = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (!match) {
      continue;
    }

    const add = match[1] === '-' ? 0 : Number.parseInt(match[1], 10);
    const del = match[2] === '-' ? 0 : Number.parseInt(match[2], 10);
    const file = match[3].trim();

    additions += Number.isFinite(add) ? add : 0;
    deletions += Number.isFinite(del) ? del : 0;
    if (file) {
      files.push(file);
    }
  }

  return {
    hash: hash.trim(),
    subject: subject.trim(),
    files,
    additions,
    deletions
  };
}

async function runRecentCommitContext(repoPath: string, maxCommits = 12): Promise<RecentCommitContext[]> {
  const args = ['log', '-n', String(Math.max(3, maxCommits)), '--no-merges', '--pretty=format:%H%x1f%s%x1e', '--numstat'];
  const { stdout } = await runGitCommand(repoPath, args);
  const records = stdout.split('\x1e').map((part) => part.trim()).filter(Boolean);
  const parsed: RecentCommitContext[] = [];

  for (const record of records) {
    const commit = parseRecentCommitRecord(record);
    if (commit) {
      parsed.push(commit);
    }
  }

  return parsed;
}

async function stageFiles(repoPath: string, files: string[]): Promise<void> {
  const unique = Array.from(new Set(files.map((file) => file.trim()).filter(Boolean)));
  if (unique.length === 0) {
    return;
  }

  await runGitCommand(repoPath, ['add', '-A', '--', ...unique]);
}

const relatedCommitSchema = z.object({
  hash: z.string(),
  subject: z.string(),
  score: z.number(),
  reason: z.string()
});

server.registerTool(
  'analyze_diff',
  {
    description: 'Analyze git diff and return structured signals for LLM-generated Conventional Commit messages.',
    inputSchema: {
      repoPath: z.string().optional().describe('Repository path (default: current working directory).'),
      staged: z.boolean().optional().describe('Use staged diff (--cached). Default true unless baseRef is set.'),
      baseRef: z.string().optional().describe('Optional base ref for comparison (example: main, origin/main, HEAD~1).'),
      maxChars: z.number().int().min(500).max(300000).optional().describe('Max diff characters to analyze.'),
      includeUntracked: z.boolean().optional().describe('Include untracked files by generating synthetic diff against /dev/null. Default true.')
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
      changedFiles: z.array(z.string()),
      relatedRecentCommits: z.array(relatedCommitSchema)
    }
  },
  async ({ repoPath, staged, baseRef, maxChars, includeUntracked }) => {
    try {
      const targetRepo = normalizeRepoPath(repoPath);
      const diff = await runGitDiff({ repoPath: targetRepo, staged, baseRef, maxChars, includeUntracked });

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
          changedFiles: [],
          relatedRecentCommits: []
        };

        return {
          content: [{ type: 'text', text: 'No changes found in selected diff scope.' }],
          structuredContent: empty
        };
      }

      const analysis = analyzeDiff(diff);
      const recentCommits = await runRecentCommitContext(targetRepo, 12);
      const relatedRecentCommits = findRelatedRecentCommits(analysis, recentCommits, 0.65, 3);

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
        changedFiles: analysis.stats.files,
        relatedRecentCommits
      };
      analyzedFilesByRepo.set(targetRepo, analysis.stats.files);

      const textSummary = [
        `Diff analyzed: ${structuredContent.stats.files} files, +${structuredContent.stats.additions}/-${structuredContent.stats.deletions}`,
        `Top type candidates: ${structuredContent.recommendedTypes.map((t) => `${t.type}(${t.score})`).join(', ')}`,
        `Scope candidates: ${structuredContent.scopeCandidates.join(', ') || '(none)'}`,
        `Related recent commits: ${structuredContent.relatedRecentCommits.length}`,
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
  'validate_tone',
  {
    description: 'Validate commit message tone and suggest a rewrite if style consistency is weak.',
    inputSchema: {
      repoPath: z.string().optional().describe('Repository path (default: current working directory).'),
      message: z.string().min(1).describe('Commit subject/header to validate.'),
      relatedRecentCommits: z
        .array(relatedCommitSchema)
        .optional()
        .describe('Optional related commits from analyze_diff. If omitted, recent history is sampled automatically.'),
      minToneScore: z.number().min(0.5).max(1).optional().describe('Rewrite threshold. Default 0.8.')
    },
    outputSchema: {
      toneScore: z.number(),
      violations: z.array(z.string()),
      suggestedRewrite: z.string(),
      applied: z.boolean()
    }
  },
  async ({ repoPath, message, relatedRecentCommits, minToneScore }) => {
    try {
      const targetRepo = normalizeRepoPath(repoPath);
      let relatedSubjects = (relatedRecentCommits ?? []).map((commit) => commit.subject).filter(Boolean);

      if (relatedSubjects.length === 0) {
        const recent = await runRecentCommitContext(targetRepo, 6);
        relatedSubjects = recent
          .filter((commit) => !isLikelyNoiseCommit(commit.subject))
          .slice(0, 3)
          .map((commit) => commit.subject);
      }

      const result = validateTone(message, { relatedSubjects, minToneScore });
      const structuredContent = {
        toneScore: result.toneScore,
        violations: result.violations,
        suggestedRewrite: result.suggestedRewrite,
        applied: result.applied
      };

      const textSummary = [
        `Tone score: ${structuredContent.toneScore}`,
        `Violations: ${structuredContent.violations.length > 0 ? structuredContent.violations.join('; ') : 'none'}`,
        `Suggested rewrite: ${structuredContent.suggestedRewrite}`,
        `Applied: ${structuredContent.applied ? 'yes' : 'no'}`
      ].join('\n');

      return {
        content: [{ type: 'text', text: textSummary }],
        structuredContent
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Unable to validate tone: ${reason}` }],
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
      dryRun: z.boolean().optional().describe('If true, runs git commit --dry-run without creating a commit.'),
      autoStageAnalyzed: z
        .boolean()
        .optional()
        .describe('If true (default), auto-stage files from the latest analyze_diff for this repo before commit.')
    },
    outputSchema: {
      success: z.boolean(),
      dryRun: z.boolean(),
      autoStageAnalyzed: z.boolean(),
      autoStagedFiles: z.number(),
      message: z.string(),
      body: z.string().nullable(),
      footer: z.string().nullable(),
      stdout: z.string(),
      stderr: z.string()
    }
  },
  async ({ repoPath, message, body, footer, dryRun, autoStageAnalyzed }) => {
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
    const shouldAutoStage = autoStageAnalyzed ?? true;

    try {
      let autoStagedFiles = 0;
      if (shouldAutoStage) {
        const analyzedFiles = analyzedFilesByRepo.get(targetRepo) ?? [];
        if (analyzedFiles.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No analyzed files found for this repository. Run analyze_diff first or set autoStageAnalyzed=false.'
              }
            ],
            isError: true
          };
        }
        await stageFiles(targetRepo, analyzedFiles);
        autoStagedFiles = analyzedFiles.length;
      }

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
        autoStageAnalyzed: shouldAutoStage,
        autoStagedFiles,
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
