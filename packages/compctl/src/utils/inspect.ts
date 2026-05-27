import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { JsonObject } from '../client.js';
import { safeJson } from '../client.js';

const SENSITIVE_PATTERNS = [
  '.env',
  '.npmrc',
  '.pem',
  '.key',
  '.crt',
  '.tfvars',
  '.tfstate',
  'terraform.tfstate',
];

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  '.terraform',
]);

export async function inspectRepo(rootPath: string): Promise<JsonObject> {
  const root = rootPath;
  const roots = await findGitRoots(root);
  const packageFiles = await findFiles(root, 'package.json', 5);
  const terraformFiles = (await findFiles(root, '.tf', 6)).filter((file) => file.endsWith('.tf'));
  const workflowFiles = (await findFiles(root, '.yml', 5))
    .concat(await findFiles(root, '.yaml', 5))
    .filter((file) => file.includes(`${sep()}.github${sep()}workflows${sep()}`));

  const packageSummaries = [];
  const dependencyNames = new Set<string>();
  for (const file of packageFiles) {
    const parsed = safeJson(await readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') continue;
    const pkg = parsed as {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    const devDeps = Object.keys(pkg.devDependencies ?? {});
    for (const dep of deps.concat(devDeps)) dependencyNames.add(dep);
    packageSummaries.push({
      path: relativeTo(root, file),
      name: pkg.name ?? basename(dirname(file)),
      dependencies: deps,
      devDependencies: devDeps,
    });
  }

  const textCorpus = [
    ...Array.from(dependencyNames),
    ...(await readSmallFiles(terraformFiles, 80_000)),
    ...(await readSmallFiles(workflowFiles, 80_000)),
  ]
    .join('\n')
    .toLowerCase();

  const vendors = detectVendors(textCorpus);
  const services = detectServices(textCorpus);
  const risks = detectRisks(vendors, services);

  return {
    inspectedAt: new Date().toISOString(),
    root,
    repositories: roots.map((repoRoot) => ({
      path: repoRoot,
      name: basename(repoRoot),
    })),
    packages: packageSummaries,
    infrastructure: {
      terraformFiles: terraformFiles.map((file) => relativeTo(root, file)),
      githubWorkflowFiles: workflowFiles.map((file) => relativeTo(root, file)),
      services,
    },
    vendors,
    risks,
    safety: {
      readOnly: true,
      skippedSensitivePatterns: SENSITIVE_PATTERNS,
    },
  };
}

async function findGitRoots(root: string): Promise<string[]> {
  const roots: string[] = [];
  await walk(root, 4, async (file, entry) => {
    if (entry.isDirectory() && entry.name === '.git') {
      roots.push(dirname(file));
    }
  });
  return Array.from(new Set(roots)).sort();
}

async function findFiles(root: string, suffix: string, maxDepth: number): Promise<string[]> {
  const files: string[] = [];
  await walk(root, maxDepth, async (file, entry) => {
    if (entry.isFile() && file.endsWith(suffix) && !isSensitive(file)) {
      files.push(file);
    }
  });
  return files.sort();
}

async function walk(
  root: string,
  maxDepth: number,
  visit: (
    file: string,
    entry: { name: string; isDirectory(): boolean; isFile(): boolean },
  ) => Promise<void> | void,
  depth = 0,
) {
  if (depth > maxDepth || isSensitive(root)) return;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = join(root, entry.name);
    await visit(file, entry);
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      await walk(file, maxDepth, visit, depth + 1);
    }
  }
}

async function readSmallFiles(files: string[], maxBytes: number): Promise<string[]> {
  const chunks = [];
  for (const file of files) {
    if (isSensitive(file)) continue;
    const info = await stat(file).catch(() => null);
    if (!info || info.size > maxBytes) continue;
    chunks.push(await readFile(file, 'utf8').catch(() => ''));
  }
  return chunks;
}

function detectVendors(text: string): Array<JsonObject> {
  const candidates = [
    ['Amazon Web Services', 'https://aws.amazon.com', 'cloud', ['aws', 'amazonaws', '@aws-sdk']],
    [
      'GitHub',
      'https://github.com',
      'software_as_a_service',
      ['github', 'actions/checkout', 'github_token'],
    ],
    ['SumSub', 'https://sumsub.com', 'software_as_a_service', ['sumsub']],
    ['Fireblocks', 'https://www.fireblocks.com', 'software_as_a_service', ['fireblocks']],
    ['Fiat Republic', 'https://fiatrepublic.com', 'finance', ['fiat republic', 'fiatrepublic']],
    ['Kraken', 'https://www.kraken.com', 'finance', ['kraken']],
    [
      'Google',
      'https://cloud.google.com',
      'software_as_a_service',
      ['google oauth', 'google-auth', 'googleapis'],
    ],
    ['TradingView', 'https://www.tradingview.com', 'software_as_a_service', ['tradingview']],
    [
      'PostgreSQL',
      'https://www.postgresql.org',
      'infrastructure',
      ['postgres', 'postgresql', 'rds'],
    ],
    ['SMTP Email Provider', undefined, 'software_as_a_service', ['smtp', 'nodemailer', 'resend']],
  ] as const;

  return candidates
    .filter(([, , , needles]) => needles.some((needle) => text.includes(needle)))
    .map(([name, website, category]) => ({
      name,
      website,
      category,
      isSubProcessor: true,
      description: `${name} detected during repository inspection.`,
    }));
}

function detectServices(text: string): string[] {
  const services = [
    ['aws-ecs', ['aws_ecs', 'ecs', 'fargate']],
    ['aws-rds', ['aws_db_instance', 'rds', 'postgres']],
    ['aws-ecr', ['aws_ecr', 'ecr']],
    ['aws-alb', ['aws_lb', 'load_balancer', 'alb']],
    ['aws-waf', ['aws_wafv2', 'waf']],
    ['aws-cloudtrail', ['cloudtrail']],
    ['aws-guardduty', ['guardduty']],
    ['aws-cloudwatch', ['cloudwatch', 'logs:']],
    ['aws-secrets-manager', ['secretsmanager', 'secrets manager']],
    ['github-actions', ['.github/workflows', 'github_token', 'actions/']],
    ['terraform', ['terraform', 'hashicorp/aws']],
  ] as const;

  return services
    .filter(([, needles]) => needles.some((needle) => text.includes(needle)))
    .map(([service]) => service);
}

function detectRisks(vendors: Array<JsonObject>, services: string[]): Array<JsonObject> {
  const risks: Array<JsonObject> = [
    {
      title: 'Cloud infrastructure misconfiguration',
      category: 'technology',
      description:
        'AWS resources, IAM, networking, logging, or encryption settings may drift from SOC 2 readiness expectations.',
    },
    {
      title: 'Source control and deployment control gaps',
      category: 'technology',
      description:
        'GitHub branch protection, CI/CD permissions, and release approvals need evidence before the Type 1 audit.',
    },
  ];

  if (vendors.length > 3) {
    risks.push({
      title: 'Third-party vendor oversight gaps',
      category: 'vendor_management',
      description:
        'Multiple critical vendors require security ownership, status, and risk treatment evidence.',
    });
  }
  if (services.includes('aws-rds')) {
    risks.push({
      title: 'Production database confidentiality and availability',
      category: 'technology',
      description:
        'Database encryption, backup retention, deletion protection, and access paths require readiness evidence.',
    });
  }
  return risks;
}

function isSensitive(file: string): boolean {
  const lower = file.toLowerCase();
  return SENSITIVE_PATTERNS.some((pattern) => lower.includes(pattern));
}

function relativeTo(root: string, file: string): string {
  return file.startsWith(root) ? file.slice(root.length + 1) : file;
}

function sep() {
  return process.platform === 'win32' ? '\\' : '/';
}
