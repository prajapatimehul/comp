import type { Command } from 'commander';
import { apiRequest, requireApiKey, type GlobalOptions } from '../client.js';
import { progress, run } from '../utils/output.js';

export function controlsCommand(program: Command) {
  const controls = program.command('controls').description('Control management commands');

  controls
    .command('list')
    .description('List all controls with relations')
    .option('--page <n>', 'Page number', '1')
    .option('--per-page <n>', 'Items per page', '100')
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        progress('Listing controls');
        return apiRequest(`/v1/controls?page=${options.page}&perPage=${options.perPage}`, {
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
        });
      }),
    );

  controls
    .command('get')
    .description('Get a single control by ID with progress details')
    .requiredOption('--id <id>', 'Control ID')
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        progress(`Getting control ${options.id}`);
        return apiRequest(`/v1/controls/${options.id}`, {
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
        });
      }),
    );

  controls
    .command('link-policies')
    .description('Link policies to a control')
    .requiredOption('--id <id>', 'Control ID')
    .requiredOption('--policy-ids <ids>', 'Comma-separated policy IDs')
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        const policyIds = options.policyIds
          .split(',')
          .map((id: string) => id.trim())
          .filter(Boolean);
        progress(`Linking ${policyIds.length} policies to control ${options.id}`);
        return apiRequest(`/v1/controls/${options.id}/policies/link`, {
          method: 'POST',
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
          body: { policyIds },
        });
      }),
    );

  controls
    .command('link-tasks')
    .description('Link tasks to a control')
    .requiredOption('--id <id>', 'Control ID')
    .requiredOption('--task-ids <ids>', 'Comma-separated task IDs')
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        const taskIds = options.taskIds
          .split(',')
          .map((id: string) => id.trim())
          .filter(Boolean);
        progress(`Linking ${taskIds.length} tasks to control ${options.id}`);
        return apiRequest(`/v1/controls/${options.id}/tasks/link`, {
          method: 'POST',
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
          body: { taskIds },
        });
      }),
    );
}
