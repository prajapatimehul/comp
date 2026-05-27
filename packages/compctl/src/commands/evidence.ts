import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { apiRequest, requireApiKey, type GlobalOptions } from '../client.js';
import { progress, run } from '../utils/output.js';

export function evidenceCommand(program: Command) {
  const evidence = program.command('evidence').description('Evidence management commands');

  evidence
    .command('list')
    .description('List all evidence forms and their submission statuses')
    .action((_options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        progress('Listing evidence forms');
        const forms = await apiRequest('/v1/evidence-forms', {
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
        });
        const statuses = await apiRequest('/v1/evidence-forms/statuses', {
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
        });
        return { forms, statuses };
      }),
    );

  evidence
    .command('get')
    .description('Get a specific evidence form with submissions')
    .requiredOption('--form-type <type>', 'Evidence form type')
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        progress(`Getting evidence form ${options.formType}`);
        return apiRequest(`/v1/evidence-forms/${options.formType}`, {
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
        });
      }),
    );

  evidence
    .command('upload')
    .description('Upload a file as evidence to a task')
    .requiredOption('--task-id <id>', 'Task ID to attach evidence to')
    .requiredOption('--file <path>', 'File path to upload')
    .option('--name <name>', 'Display name for the attachment')
    .option('--user-id <id>', 'User ID (required for API key auth)')
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        const filePath = resolve(options.file);
        const fileBuffer = await readFile(filePath);
        const fileName = options.name ?? basename(filePath);
        const fileData = fileBuffer.toString('base64');

        const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
        const mimeTypes: Record<string, string> = {
          pdf: 'application/pdf',
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          md: 'text/markdown',
          txt: 'text/plain',
          json: 'application/json',
          csv: 'text/csv',
          doc: 'application/msword',
          docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        };
        const fileType = mimeTypes[ext] ?? 'application/octet-stream';

        progress(`Uploading ${fileName} to task ${options.taskId}`);
        const body: Record<string, string> = { fileName, fileData, fileType };
        if (options.userId) body.userId = options.userId;
        return apiRequest(`/v1/tasks/${options.taskId}/attachments`, {
          method: 'POST',
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
          body,
        });
      }),
    );

  evidence
    .command('task-attachments')
    .description('List attachments for a task')
    .requiredOption('--task-id <id>', 'Task ID')
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        progress(`Listing attachments for task ${options.taskId}`);
        return apiRequest(`/v1/tasks/${options.taskId}/attachments`, {
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
        });
      }),
    );
}
