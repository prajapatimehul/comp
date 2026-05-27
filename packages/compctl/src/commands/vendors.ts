import type { Command } from 'commander';
import { apiRequest, requireApiKey, type GlobalOptions } from '../client.js';
import { progress, run } from '../utils/output.js';

export function vendorsCommand(program: Command) {
  const vendors = program.command('vendors').description('Vendor management commands');

  vendors
    .command('list')
    .description('List all vendors')
    .action((_options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        progress('Listing vendors');
        return apiRequest('/v1/vendors', {
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
        });
      }),
    );

  vendors
    .command('get')
    .description('Get a single vendor by ID')
    .requiredOption('--id <id>', 'Vendor ID')
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        progress(`Getting vendor ${options.id}`);
        return apiRequest(`/v1/vendors/${options.id}`, {
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
        });
      }),
    );

  vendors
    .command('update')
    .description('Update a vendor (status, description, category, risk levels)')
    .requiredOption('--id <id>', 'Vendor ID')
    .option('--name <name>', 'Vendor name')
    .option('--description <desc>', 'Vendor description')
    .option('--status <status>', 'Status: not_assessed, in_progress, assessed')
    .option(
      '--category <cat>',
      'Category: cloud, infrastructure, software_as_a_service, finance, marketing, sales, hr, other',
    )
    .option('--website <url>', 'Vendor website URL')
    .option(
      '--inherent-probability <level>',
      'Inherent probability: very_unlikely, unlikely, possible, likely, very_likely',
    )
    .option(
      '--inherent-impact <level>',
      'Inherent impact: insignificant, minor, moderate, major, severe',
    )
    .option('--residual-probability <level>', 'Residual probability')
    .option('--residual-impact <level>', 'Residual impact')
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        const body: Record<string, unknown> = {};
        if (options.name) body.name = options.name;
        if (options.description) body.description = options.description;
        if (options.status) body.status = options.status;
        if (options.category) body.category = options.category;
        if (options.website) body.website = options.website;
        if (options.inherentProbability) body.inherentProbability = options.inherentProbability;
        if (options.inherentImpact) body.inherentImpact = options.inherentImpact;
        if (options.residualProbability) body.residualProbability = options.residualProbability;
        if (options.residualImpact) body.residualImpact = options.residualImpact;

        progress(`Updating vendor ${options.id}`);
        return apiRequest(`/v1/vendors/${options.id}`, {
          method: 'PATCH',
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
          body,
        });
      }),
    );

  vendors
    .command('assess')
    .description('Trigger AI risk assessment for a vendor')
    .requiredOption('--id <id>', 'Vendor ID')
    .option('--no-research', 'Skip web research (cheaper but less thorough)')
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        progress(`Triggering assessment for vendor ${options.id}`);
        return apiRequest(`/v1/vendors/${options.id}/trigger-assessment`, {
          method: 'POST',
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
          body: { withResearch: options.research !== false },
        });
      }),
    );
}
