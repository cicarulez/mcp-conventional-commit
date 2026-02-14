export type ConventionalType =
  | 'feat'
  | 'fix'
  | 'refactor'
  | 'docs'
  | 'test'
  | 'chore'
  | 'build'
  | 'ci'
  | 'perf'
  | 'style';

export interface DiffStats {
  files: string[];
  additions: number;
  deletions: number;
  hasBreakingHint: boolean;
  hasTestFiles: boolean;
  hasDocsFiles: boolean;
  hasConfigFiles: boolean;
  hasCodeFiles: boolean;
  addedFiles: number;
  deletedFiles: number;
  renamedFiles: number;
  featureSignals: number;
  fixSignals: number;
  refactorSignals: number;
  perfSignals: number;
  styleSignals: number;
}

export interface TypeScore {
  type: ConventionalType;
  score: number;
  reason: string;
}

export interface DiffAnalysis {
  stats: DiffStats;
  scopeCandidates: string[];
  recommendedTypes: TypeScore[];
  subjectHints: string[];
}

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.adoc', '.txt']);
const TEST_HINTS = ['test', 'spec', '__tests__', '__mocks__', 'fixtures'];
const CONFIG_HINTS = [
  '.github/',
  '.gitlab/',
  '.vscode/',
  '.husky/',
  'dockerfile',
  'docker-compose',
  'tsconfig',
  'eslint',
  'prettier',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock'
];

const FEATURE_KEYWORDS = ['add ', 'adds ', 'added ', 'new ', 'create', 'introduce', 'support', 'enable', 'implement', 'expose'];
const FIX_KEYWORDS = ['fix', 'bug', 'error', 'exception', 'prevent', 'handle', 'resolve', 'correct', 'fallback', 'guard', 'null', 'undefined'];
const REFACTOR_KEYWORDS = ['refactor', 'cleanup', 'simplify', 'reorganize', 'extract', 'rename', 'move ', 'split '];
const PERF_KEYWORDS = ['optimiz', 'performance', 'faster', 'latency', 'throughput', 'memo', 'cache', 'benchmark'];
const STYLE_KEYWORDS = ['format', 'lint', 'prettier', 'eslint-disable'];

function extensionOf(file: string): string {
  const idx = file.lastIndexOf('.');
  return idx === -1 ? '' : file.slice(idx).toLowerCase();
}

function isDoc(file: string): boolean {
  const lc = file.toLowerCase();
  return lc.startsWith('docs/') || DOC_EXTENSIONS.has(extensionOf(lc));
}

function isTest(file: string): boolean {
  const lc = file.toLowerCase();
  return TEST_HINTS.some((h) => lc.includes(h));
}

function isConfig(file: string): boolean {
  const lc = file.toLowerCase();
  return CONFIG_HINTS.some((h) => lc.includes(h));
}

function isCode(file: string): boolean {
  if (isDoc(file) || isConfig(file)) {
    return false;
  }

  const ext = extensionOf(file);
  return Boolean(ext) && !['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.pdf', '.lock'].includes(ext);
}

function countKeywordHits(line: string, keywords: string[]): number {
  let hits = 0;
  for (const kw of keywords) {
    if (line.includes(kw)) {
      hits += 1;
    }
  }
  return hits;
}

function isStyleOnlyChange(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return true;
  }

  if (/^[{}()[\];,.]+$/.test(trimmed)) {
    return true;
  }

  return /^\s*(\/\/|\*|\*\/)/.test(line);
}

function uniqueScopes(files: string[]): string[] {
  const scopes = new Set<string>();

  for (const file of files) {
    const parts = file.split('/').filter(Boolean);
    if (parts.length > 1 && parts[0] !== 'src' && parts[0] !== 'lib') {
      scopes.add(parts[0].toLowerCase().replace(/[^a-z0-9_-]/g, ''));
      continue;
    }

    const filename = parts[parts.length - 1] ?? file;
    const stem = filename.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (stem) {
      scopes.add(stem.slice(0, 30));
    }
  }

  return Array.from(scopes).filter(Boolean).slice(0, 5);
}

function summarizeTarget(files: string[]): string {
  if (files.length === 0) {
    return 'codebase';
  }

  if (files.length === 1) {
    const one = files[0].split('/').pop() ?? files[0];
    return one.replace(/\.[^.]+$/, '').toLowerCase();
  }

  const roots = new Set(files.map((f) => f.split('/')[0] || 'root'));
  if (roots.size === 1) {
    return Array.from(roots)[0].toLowerCase();
  }

  return 'multiple-modules';
}

export function parseGitDiff(diffText: string): DiffStats {
  const files: string[] = [];
  let additions = 0;
  let deletions = 0;
  let hasBreakingHint = false;
  let addedFiles = 0;
  let deletedFiles = 0;
  let renamedFiles = 0;
  let featureSignals = 0;
  let fixSignals = 0;
  let refactorSignals = 0;
  let perfSignals = 0;
  let styleSignals = 0;

  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (match?.[2]) {
        files.push(match[2]);
      }
      continue;
    }

    if (line.startsWith('new file mode ')) {
      addedFiles += 1;
      continue;
    }

    if (line.startsWith('deleted file mode ')) {
      deletedFiles += 1;
      continue;
    }

    if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
      renamedFiles += 1;
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      additions += 1;
      const text = line.slice(1).toLowerCase();
      if (line.includes('BREAKING CHANGE') || line.includes('!:')) {
        hasBreakingHint = true;
      }
      featureSignals += countKeywordHits(text, FEATURE_KEYWORDS);
      fixSignals += countKeywordHits(text, FIX_KEYWORDS);
      refactorSignals += countKeywordHits(text, REFACTOR_KEYWORDS);
      perfSignals += countKeywordHits(text, PERF_KEYWORDS);
      styleSignals += countKeywordHits(text, STYLE_KEYWORDS);
      if (isStyleOnlyChange(text)) {
        styleSignals += 1;
      }
      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      deletions += 1;
      const text = line.slice(1).toLowerCase();
      if (line.includes('BREAKING CHANGE') || line.includes('!:')) {
        hasBreakingHint = true;
      }
      fixSignals += countKeywordHits(text, FIX_KEYWORDS);
      refactorSignals += countKeywordHits(text, REFACTOR_KEYWORDS);
      perfSignals += countKeywordHits(text, PERF_KEYWORDS);
      styleSignals += countKeywordHits(text, STYLE_KEYWORDS);
      if (isStyleOnlyChange(text)) {
        styleSignals += 1;
      }
    }
  }

  return {
    files,
    additions,
    deletions,
    hasBreakingHint,
    hasTestFiles: files.some(isTest),
    hasDocsFiles: files.some(isDoc),
    hasConfigFiles: files.some(isConfig),
    hasCodeFiles: files.some(isCode),
    addedFiles,
    deletedFiles,
    renamedFiles,
    featureSignals,
    fixSignals,
    refactorSignals,
    perfSignals,
    styleSignals
  };
}

function scoreTypes(stats: DiffStats): TypeScore[] {
  const scores = new Map<ConventionalType, number>([
    ['feat', 0],
    ['fix', 0],
    ['refactor', 0],
    ['docs', 0],
    ['test', 0],
    ['chore', 0],
    ['build', 0],
    ['ci', 0],
    ['perf', 0],
    ['style', 0]
  ]);

  const inc = (type: ConventionalType, value: number): void => {
    scores.set(type, (scores.get(type) ?? 0) + value);
  };

  if (stats.files.length === 0) {
    inc('chore', 10);
  }

  if (stats.files.length > 0 && stats.files.every(isDoc)) {
    inc('docs', 12);
  }

  if (stats.files.length > 0 && stats.files.every(isTest)) {
    inc('test', 12);
  }

  if (stats.files.length > 0 && stats.files.every(isConfig)) {
    inc('chore', 7);
    if (stats.files.some((f) => f.includes('.github/'))) {
      inc('ci', 8);
    }
    if (stats.files.some((f) => f.includes('package.json') || f.includes('lock') || f.includes('docker'))) {
      inc('build', 8);
    }
  }

  inc('feat', stats.featureSignals + stats.addedFiles * 2 + (stats.additions > stats.deletions ? 1 : 0));
  inc('fix', stats.fixSignals + (stats.deletions > stats.additions ? 1 : 0));
  inc('refactor', stats.refactorSignals + (stats.renamedFiles > 0 ? 3 : 0));
  inc('perf', stats.perfSignals * 2);
  inc('style', stats.styleSignals);

  if (stats.deletions > stats.additions * 2 && stats.hasCodeFiles) {
    inc('refactor', 2);
  }

  if (stats.styleSignals > Math.max(3, stats.additions + stats.deletions / 3) && stats.hasCodeFiles) {
    inc('style', 3);
  }

  if (stats.hasCodeFiles && (scores.get('fix') ?? 0) === 0 && (scores.get('feat') ?? 0) === 0) {
    inc('fix', 1);
  }

  if (!stats.hasCodeFiles && !stats.hasDocsFiles && !stats.hasConfigFiles && !stats.hasTestFiles) {
    inc('chore', 2);
  }

  const reasons: Record<ConventionalType, string> = {
    feat: `featureSignals=${stats.featureSignals}, addedFiles=${stats.addedFiles}`,
    fix: `fixSignals=${stats.fixSignals}, deletions=${stats.deletions}`,
    refactor: `refactorSignals=${stats.refactorSignals}, renamedFiles=${stats.renamedFiles}`,
    docs: `hasDocsFiles=${stats.hasDocsFiles}`,
    test: `hasTestFiles=${stats.hasTestFiles}`,
    chore: `hasConfigFiles=${stats.hasConfigFiles}`,
    build: `config/build files detected`,
    ci: `ci config detected`,
    perf: `perfSignals=${stats.perfSignals}`,
    style: `styleSignals=${stats.styleSignals}`
  };

  return Array.from(scores.entries())
    .map(([type, score]) => ({ type, score, reason: reasons[type] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
}

function buildSubjectHints(stats: DiffStats): string[] {
  const target = summarizeTarget(stats.files);
  return [
    `update ${target} behavior`,
    `add ${target} support`,
    `refactor ${target} implementation`,
    `optimize ${target} performance`
  ];
}

export function analyzeDiff(diffText: string): DiffAnalysis {
  const stats = parseGitDiff(diffText);
  return {
    stats,
    scopeCandidates: uniqueScopes(stats.files),
    recommendedTypes: scoreTypes(stats),
    subjectHints: buildSubjectHints(stats)
  };
}
