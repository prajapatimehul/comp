import type { Command } from 'commander';
import { apiRequest, requireApiKey, type GlobalOptions } from '../client.js';
import { progress, run } from '../utils/output.js';

export function risksCommand(program: Command) {
  const risks = program.command('risks').description('Risk management commands');

  risks
    .command('list')
    .description('List all risks')
    .action((_options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        progress('Listing risks');
        return apiRequest('/v1/risks?perPage=200', {
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
        });
      }),
    );

  risks
    .command('get')
    .description('Get a single risk by ID')
    .requiredOption('--id <id>', 'Risk ID')
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        progress(`Getting risk ${options.id}`);
        return apiRequest(`/v1/risks/${options.id}`, {
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
        });
      }),
    );

  risks
    .command('update')
    .description('Update a risk (status, treatment, likelihood, impact)')
    .requiredOption('--id <id>', 'Risk ID')
    .option('--title <title>', 'Risk title')
    .option('--description <desc>', 'Risk description')
    .option('--status <status>', 'Status: open, pending, closed, archived')
    .option(
      '--category <cat>',
      'Category: customer, fraud, governance, operations, other, people, regulatory, reporting, resilience, technology, vendor_management',
    )
    .option('--department <dept>', 'Department: none, admin, gov, hr, it, itsm, qms')
    .option('--treatment-strategy <strategy>', 'Treatment: accept, avoid, mitigate, transfer')
    .option('--treatment-description <desc>', 'Treatment strategy description')
    .option(
      '--likelihood <level>',
      'Likelihood: very_unlikely, unlikely, possible, likely, very_likely',
    )
    .option('--impact <level>', 'Impact: insignificant, minor, moderate, major, severe')
    .option('--residual-likelihood <level>', 'Residual likelihood after treatment')
    .option('--residual-impact <level>', 'Residual impact after treatment')
    .option('--assignee-id <id>', 'Assignee member ID')
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        const body: Record<string, unknown> = {};
        if (options.title) body.title = options.title;
        if (options.description) body.description = options.description;
        if (options.status) body.status = options.status;
        if (options.category) body.category = options.category;
        if (options.department) body.department = options.department;
        if (options.treatmentStrategy) body.treatmentStrategy = options.treatmentStrategy;
        if (options.treatmentDescription)
          body.treatmentStrategyDescription = options.treatmentDescription;
        if (options.likelihood) body.likelihood = options.likelihood;
        if (options.impact) body.impact = options.impact;
        if (options.residualLikelihood) body.residualLikelihood = options.residualLikelihood;
        if (options.residualImpact) body.residualImpact = options.residualImpact;
        if (options.assigneeId) body.assigneeId = options.assigneeId;

        progress(`Updating risk ${options.id}`);
        return apiRequest(`/v1/risks/${options.id}`, {
          method: 'PATCH',
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
          body,
        });
      }),
    );
}
