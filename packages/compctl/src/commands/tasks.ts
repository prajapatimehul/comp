import type { Command } from 'commander';
import { apiRequest, requireApiKey, type GlobalOptions } from '../client.js';
import { progress, run } from '../utils/output.js';

export function tasksCommand(program: Command) {
  const tasks = program.command('tasks').description('Task management commands');

  tasks
    .command('list')
    .description('List all tasks')
    .action((_options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        progress('Listing tasks');
        return apiRequest('/v1/tasks?includeRelations=true', {
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
        });
      }),
    );

  tasks
    .command('get')
    .description('Get a single task by ID')
    .requiredOption('--id <id>', 'Task ID')
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        progress(`Getting task ${options.id}`);
        return apiRequest(`/v1/tasks/${options.id}`, {
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
        });
      }),
    );

  tasks
    .command('update')
    .description('Update a task (status, title, description, assignee, department)')
    .requiredOption('--id <id>', 'Task ID')
    .option('--status <status>', 'Status: todo, in_progress, done, not_relevant')
    .option('--title <title>', 'Task title')
    .option('--description <desc>', 'Task description')
    .option('--assignee-id <id>', 'Assignee member ID')
    .option('--department <dept>', 'Department: none, admin, gov, hr, it, itsm, qms')
    .option('--frequency <freq>', 'Frequency: daily, weekly, monthly, quarterly, yearly')
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        const body: Record<string, unknown> = {};
        if (options.status) body.status = options.status;
        if (options.title) body.title = options.title;
        if (options.description) body.description = options.description;
        if (options.assigneeId) body.assigneeId = options.assigneeId;
        if (options.department) body.department = options.department;
        if (options.frequency) body.frequency = options.frequency;

        progress(`Updating task ${options.id}`);
        return apiRequest(`/v1/tasks/${options.id}`, {
          method: 'PATCH',
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
          body,
        });
      }),
    );

  tasks
    .command('bulk-update')
    .description('Bulk update task statuses')
    .requiredOption('--ids <ids>', 'Comma-separated task IDs')
    .requiredOption('--status <status>', 'Status: todo, in_progress, done, not_relevant')
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        const taskIds = options.ids
          .split(',')
          .map((id: string) => id.trim())
          .filter(Boolean);
        progress(`Bulk updating ${taskIds.length} tasks to ${options.status}`);
        return apiRequest('/v1/tasks/bulk', {
          method: 'PATCH',
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
          body: { taskIds, status: options.status },
        });
      }),
    );
}
