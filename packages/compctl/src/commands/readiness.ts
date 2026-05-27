import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  apiRequest,
  CliError,
  requireApiKey,
  responseArray,
  type GlobalOptions,
  type JsonObject,
} from '../client.js';
import { inspectRepo } from '../utils/inspect.js';
import { progress, run } from '../utils/output.js';

export function readinessCommand(program: Command) {
  const readiness = program.command('readiness').description('SOC 2 readiness commands');

  readiness
    .command('status')
    .description('Read Comp AI readiness status')
    .action((_options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        progress('Reading readiness status from Comp AI');
        return apiRequest('/v1/readiness/status', {
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
        });
      }),
    );

  readiness
    .command('apply')
    .description('Apply repo/vendor/risk context through the normal Comp AI API flow')
    .option('--repo <path>', 'Repository root or parent folder to inspect')
    .option('--repo-context-file <path>', 'Precomputed repo context JSON')
    .option('--framework <name>', 'Built-in framework name to ensure', 'SOC 2 Type 1')
    .option(
      '--no-complete-onboarding',
      'Leave the organization in onboarding instead of opening the app',
    )
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        const repoContext = await loadRepoContext(options.repo, options.repoContextFile);
        const vendors = Array.isArray(repoContext?.vendors) ? repoContext.vendors : [];
        const risks = Array.isArray(repoContext?.risks) ? repoContext.risks : [];

        progress('Applying readiness context through standard Comp AI APIs');
        return applyReadinessFlow({
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
          framework: options.framework,
          repoContext,
          vendors: vendors as JsonObject[],
          risks: risks as JsonObject[],
          completeOnboarding: options.completeOnboarding !== false,
        });
      }),
    );

  readiness
    .command('quarantine-generated')
    .description('Quarantine legacy compctl-generated fake readiness data')
    .option('--dry-run', 'Show what would be quarantined without changing data')
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        progress('Quarantining legacy compctl-generated fake readiness data');
        return apiRequest('/v1/readiness/quarantine-generated', {
          method: 'POST',
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
          body: { dryRun: options.dryRun === true },
        });
      }),
    );
}

async function loadRepoContext(repoPath?: string, contextFile?: string): Promise<JsonObject> {
  if (contextFile) {
    return JSON.parse(await readFile(resolve(contextFile), 'utf8')) as JsonObject;
  }
  if (repoPath) {
    return inspectRepo(resolve(repoPath));
  }
  return {};
}

async function applyReadinessFlow(params: {
  apiUrl?: string;
  apiKey: string;
  framework: string;
  repoContext: JsonObject;
  vendors: JsonObject[];
  risks: JsonObject[];
  completeOnboarding: boolean;
}) {
  const frameworkImport = await ensureBuiltInFrameworkViaApi(params);
  const context = await upsertReadinessContextViaApi(params);
  const vendors = await upsertCandidateVendorsViaApi(params);
  const risks = await upsertCandidateRisksViaApi(params);

  let organization: unknown = null;
  if (params.completeOnboarding) {
    organization = await apiRequest('/v1/organization', {
      method: 'PATCH',
      apiUrl: params.apiUrl,
      apiKey: params.apiKey,
      body: { onboardingCompleted: true, hasAccess: true },
    });
  }

  const status = await apiRequest('/v1/readiness/status', {
    apiUrl: params.apiUrl,
    apiKey: params.apiKey,
  });

  return {
    mode: 'standard-api-flow-no-fake-completion',
    frameworkImport,
    context,
    vendors,
    risks,
    organization,
    evidence: {
      created: 0,
      approved: 0,
      note: 'No evidence was created or approved by comp.',
    },
    tasks: {
      completedByCompctl: 0,
      note: 'Built-in template tasks remain todo until completed through the normal task workflow.',
    },
    policies: {
      publishedByCompctl: 0,
      note: 'Built-in template policies remain draft until a user publishes them.',
    },
    status,
  };
}

async function ensureBuiltInFrameworkViaApi(params: {
  apiUrl?: string;
  apiKey: string;
  framework: string;
}) {
  const existing = await apiRequest('/v1/frameworks', {
    apiUrl: params.apiUrl,
    apiKey: params.apiKey,
  });
  const existingFrameworks = responseArray(existing);
  const existingMatch = existingFrameworks.find((item) => {
    const framework = item as {
      framework?: { name?: string };
      customFramework?: { name?: string };
    };
    return (
      framework.framework?.name && frameworkNameMatches(params.framework, framework.framework.name)
    );
  });
  if (existingMatch) {
    return { alreadyPresent: true, selected: summarizeFrameworkInstance(existingMatch) };
  }

  const available = await apiRequest('/v1/frameworks/available', {
    apiUrl: params.apiUrl,
    apiKey: params.apiKey,
  });
  const selected = selectFramework(params.framework, responseArray(available));
  const added = await apiRequest('/v1/frameworks', {
    method: 'POST',
    apiUrl: params.apiUrl,
    apiKey: params.apiKey,
    body: { frameworkIds: [selected.id] },
  });

  return { alreadyPresent: false, selected, added };
}

function selectFramework(requested: string, frameworks: unknown[]) {
  const candidates = frameworks
    .map((framework) => framework as { id?: string; name?: string; isCustom?: boolean })
    .filter((framework) => framework.id && framework.name && framework.isCustom !== true);
  const exact = candidates.find(
    (framework) => framework.name!.toLowerCase() === requested.toLowerCase(),
  );
  const soc2 = candidates.find((framework) => frameworkNameMatches(requested, framework.name!));
  const selected = exact ?? soc2;
  if (!selected?.id || !selected.name) {
    throw new CliError(
      `Could not find a built-in framework matching "${requested}".`,
      'FRAMEWORK_NOT_FOUND',
    );
  }
  return { id: selected.id, name: selected.name };
}

function frameworkNameMatches(requested: string, actual: string) {
  const requestedLower = requested.toLowerCase();
  const actualLower = actual.toLowerCase();
  if (actualLower === requestedLower) return true;
  if (requestedLower.includes('soc') && requestedLower.includes('2')) {
    return actualLower.includes('soc') && actualLower.includes('2');
  }
  return actualLower.includes(requestedLower) || requestedLower.includes(actualLower);
}

function summarizeFrameworkInstance(value: unknown) {
  const instance = value as {
    id?: string;
    frameworkId?: string;
    framework?: { name?: string };
  };
  return {
    id: instance.id,
    frameworkId: instance.frameworkId,
    name: instance.framework?.name,
  };
}

async function upsertReadinessContextViaApi(params: {
  apiUrl?: string;
  apiKey: string;
  repoContext: JsonObject;
  vendors: JsonObject[];
}) {
  const entries = [
    {
      question: 'Comp CLI repository inspection context',
      answer: compactContextAnswer(params.repoContext),
      tags: ['comp', 'repository', 'onboarding', 'unverified'],
    },
    {
      question: 'Comp readiness workflow mode',
      answer:
        'CLI captured context and used built-in Comp AI framework templates through public APIs. It did not complete tasks, publish policies, approve evidence, assess vendors, or close risks.',
      tags: ['comp', 'onboarding', 'truthful-readiness'],
    },
  ];

  if (params.vendors.length > 0) {
    entries.push({
      question: 'What software do you use?',
      answer: params.vendors
        .map((vendor) => String(vendor.name ?? ''))
        .filter(Boolean)
        .join(', '),
      tags: ['onboarding', 'comp', 'unverified'],
    });
    entries.push({
      question: 'What are your custom vendors and their websites?',
      answer: JSON.stringify(
        params.vendors.map((vendor) => ({
          name: vendor.name,
          website: vendor.website,
        })),
      ),
      tags: ['onboarding', 'comp', 'unverified'],
    });
  }

  const upserted = [];
  for (const entry of entries) {
    upserted.push(await upsertContextEntryViaApi(params, entry));
  }
  return { upserted: upserted.length };
}

function compactContextAnswer(repoContext: JsonObject): string {
  const repositories = Array.isArray(repoContext.repositories)
    ? repoContext.repositories.map((repo) => {
        const item = repo as { name?: string; path?: string };
        return item.name ?? item.path;
      })
    : [];
  const packages = Array.isArray(repoContext.packages)
    ? repoContext.packages.map((pkg) => {
        const item = pkg as { name?: string; path?: string };
        return item.name ?? item.path;
      })
    : [];
  const infrastructure = repoContext.infrastructure as
    | {
        services?: unknown[];
        terraformFiles?: unknown[];
        githubWorkflowFiles?: unknown[];
      }
    | undefined;

  const summary = {
    inspectedAt: repoContext.inspectedAt,
    repositories: repositories.filter(Boolean).slice(0, 12),
    packages: packages.filter(Boolean).slice(0, 20),
    infrastructure: {
      services: Array.isArray(infrastructure?.services)
        ? infrastructure.services.filter(Boolean).slice(0, 20)
        : [],
      terraformFileCount: Array.isArray(infrastructure?.terraformFiles)
        ? infrastructure.terraformFiles.length
        : 0,
      githubWorkflowFileCount: Array.isArray(infrastructure?.githubWorkflowFiles)
        ? infrastructure.githubWorkflowFiles.length
        : 0,
    },
    vendorCandidates: Array.isArray(repoContext.vendors)
      ? repoContext.vendors
          .map((vendor) => (vendor as { name?: string }).name)
          .filter(Boolean)
          .slice(0, 20)
      : [],
    riskCandidates: Array.isArray(repoContext.risks)
      ? repoContext.risks
          .map((risk) => (risk as { title?: string }).title)
          .filter(Boolean)
          .slice(0, 20)
      : [],
    compReadOnly: true,
    verificationStatus: 'unverified_human_review_required',
  };

  return fitContextAnswer(JSON.stringify(summary));
}

function fitContextAnswer(answer: string, maxLength = 1800): string {
  if (answer.length <= maxLength) return answer;
  return `${answer.slice(0, maxLength - 80)}... truncated; full inspection remains local and unverified.`;
}

async function upsertContextEntryViaApi(
  params: { apiUrl?: string; apiKey: string },
  entry: { question: string; answer: string; tags: string[] },
) {
  const existing = await apiRequest('/v1/context', {
    apiUrl: params.apiUrl,
    apiKey: params.apiKey,
  });
  const match = responseArray(existing).find((item) => {
    const context = item as { id?: string; question?: string };
    return context.question === entry.question;
  }) as { id?: string } | undefined;

  if (match?.id) {
    return apiRequest(`/v1/context/${match.id}`, {
      method: 'PATCH',
      apiUrl: params.apiUrl,
      apiKey: params.apiKey,
      body: entry,
    });
  }

  return apiRequest('/v1/context', {
    method: 'POST',
    apiUrl: params.apiUrl,
    apiKey: params.apiKey,
    body: entry,
  });
}

async function upsertCandidateVendorsViaApi(params: {
  apiUrl?: string;
  apiKey: string;
  vendors: JsonObject[];
}) {
  const existing = await apiRequest('/v1/vendors', {
    apiUrl: params.apiUrl,
    apiKey: params.apiKey,
  });
  const existingVendors = responseArray(existing);
  const results = [];

  for (const vendor of dedupeByName(params.vendors, 'name')) {
    const name = String(vendor.name ?? '').trim();
    if (!name) continue;
    const match = existingVendors.find((item) => {
      const existingVendor = item as { name?: string };
      return existingVendor.name?.toLowerCase() === name.toLowerCase();
    }) as { id?: string; status?: string } | undefined;
    const body = {
      name,
      website: typeof vendor.website === 'string' ? vendor.website : undefined,
      description:
        typeof vendor.description === 'string' && vendor.description.trim()
          ? vendor.description
          : `${name} was identified from read-only comp context and requires human vendor review.`,
      category: toVendorCategory(String(vendor.category ?? '')),
      status: match?.status === 'assessed' ? match.status : 'not_assessed',
      isSubProcessor: typeof vendor.isSubProcessor === 'boolean' ? vendor.isSubProcessor : true,
    };

    if (match?.id) {
      results.push({
        reused: true,
        vendor: await apiRequest(`/v1/vendors/${match.id}`, {
          method: 'PATCH',
          apiUrl: params.apiUrl,
          apiKey: params.apiKey,
          body,
        }),
      });
    } else {
      results.push({
        reused: false,
        vendor: await apiRequest('/v1/vendors', {
          method: 'POST',
          apiUrl: params.apiUrl,
          apiKey: params.apiKey,
          body,
        }),
      });
    }
  }

  return { upserted: results.length, results };
}

async function upsertCandidateRisksViaApi(params: {
  apiUrl?: string;
  apiKey: string;
  risks: JsonObject[];
}) {
  const existing = await apiRequest('/v1/risks?perPage=200', {
    apiUrl: params.apiUrl,
    apiKey: params.apiKey,
  });
  const existingRisks = responseArray(existing);
  const results = [];

  for (const risk of dedupeByName(params.risks, 'title')) {
    const title = String(risk.title ?? '').trim();
    if (!title) continue;
    const match = existingRisks.find((item) => {
      const existingRisk = item as { title?: string };
      return existingRisk.title?.toLowerCase() === title.toLowerCase();
    }) as { id?: string; status?: string } | undefined;
    const body = {
      title,
      description:
        typeof risk.description === 'string' && risk.description.trim()
          ? risk.description
          : `${title} was identified from read-only comp context and requires human risk review.`,
      category: toRiskCategory(String(risk.category ?? '')),
      department: 'it',
      status: match?.status === 'closed' ? match.status : 'pending',
    };

    if (match?.id) {
      results.push({
        reused: true,
        risk: await apiRequest(`/v1/risks/${match.id}`, {
          method: 'PATCH',
          apiUrl: params.apiUrl,
          apiKey: params.apiKey,
          body,
        }),
      });
    } else {
      results.push({
        reused: false,
        risk: await apiRequest('/v1/risks', {
          method: 'POST',
          apiUrl: params.apiUrl,
          apiKey: params.apiKey,
          body,
        }),
      });
    }
  }

  return { upserted: results.length, results };
}

function dedupeByName(items: JsonObject[], key: 'name' | 'title') {
  const deduped = new Map<string, JsonObject>();
  for (const item of items) {
    const value = String(item[key] ?? '').trim();
    if (value) deduped.set(value.toLowerCase(), item);
  }
  return Array.from(deduped.values());
}

function toVendorCategory(value: string) {
  const allowed = new Set([
    'cloud',
    'infrastructure',
    'software_as_a_service',
    'finance',
    'marketing',
    'sales',
    'hr',
    'other',
  ]);
  const normalized = value.trim().replace(/-/g, '_');
  return allowed.has(normalized) ? normalized : 'other';
}

function toRiskCategory(value: string) {
  const allowed = new Set([
    'customer',
    'fraud',
    'governance',
    'operations',
    'other',
    'people',
    'regulatory',
    'reporting',
    'resilience',
    'technology',
    'vendor_management',
  ]);
  const normalized = value.trim().replace(/-/g, '_');
  return allowed.has(normalized) ? normalized : 'technology';
}
