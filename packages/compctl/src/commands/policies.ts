import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { apiRequest, requireApiKey, type GlobalOptions } from '../client.js';
import { progress, run } from '../utils/output.js';

export function policiesCommand(program: Command) {
  const policies = program.command('policies').description('Policy management commands');

  policies
    .command('list')
    .description('List all policies')
    .action((_options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        progress('Listing policies');
        return apiRequest('/v1/policies', {
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
        });
      }),
    );

  policies
    .command('get')
    .description('Get a single policy by ID')
    .requiredOption('--id <id>', 'Policy ID')
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        progress(`Getting policy ${options.id}`);
        return apiRequest(`/v1/policies/${options.id}`, {
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
        });
      }),
    );

  policies
    .command('update')
    .description('Update a policy (name, content, status, department, frequency)')
    .requiredOption('--id <id>', 'Policy ID')
    .option('--name <name>', 'Policy name')
    .option('--content <json>', 'TipTap JSON content (string or @filepath)')
    .option('--status <status>', 'Policy status: draft, published, needs_review')
    .option('--department <dept>', 'Department: none, admin, gov, hr, it, itsm, qms')
    .option('--frequency <freq>', 'Review frequency: monthly, quarterly, yearly')
    .option('--assignee-id <id>', 'Assignee member ID')
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        const body: Record<string, unknown> = {};
        if (options.name) body.name = options.name;
        if (options.status) body.status = options.status;
        if (options.department) body.department = options.department;
        if (options.frequency) body.frequency = options.frequency;
        if (options.assigneeId) body.assigneeId = options.assigneeId;
        if (options.content) {
          body.content = await resolveContent(options.content);
        }

        progress(`Updating policy ${options.id}`);
        return apiRequest(`/v1/policies/${options.id}`, {
          method: 'PATCH',
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
          body,
        });
      }),
    );

  policies
    .command('publish-all')
    .description('Publish all draft policies at once')
    .action((_options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        progress('Publishing all draft policies');
        return apiRequest('/v1/policies/publish-all', {
          method: 'POST',
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
        });
      }),
    );

  policies
    .command('controls')
    .description('Get controls mapped to a policy')
    .requiredOption('--id <id>', 'Policy ID')
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        progress(`Getting controls for policy ${options.id}`);
        return apiRequest(`/v1/policies/${options.id}/controls`, {
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
        });
      }),
    );

  policies
    .command('versions')
    .description('List versions of a policy')
    .requiredOption('--id <id>', 'Policy ID')
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        progress(`Getting versions for policy ${options.id}`);
        return apiRequest(`/v1/policies/${options.id}/versions`, {
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
        });
      }),
    );
}

async function resolveContent(value: string): Promise<unknown> {
  if (value.startsWith('@')) {
    const filePath = resolve(value.slice(1));
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  }
  try {
    return JSON.parse(value);
  } catch {
    return wrapPlainText(value);
  }
}

function wrapPlainText(text: string): unknown[] {
  return text.split('\n').map((line) => ({
    type: 'paragraph',
    content: line.trim() ? [{ type: 'text', text: line }] : [],
  }));
}
