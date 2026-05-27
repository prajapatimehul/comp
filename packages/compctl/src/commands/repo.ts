import type { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inspectRepo } from '../utils/inspect.js';
import { progress, run } from '../utils/output.js';

export function repoCommand(program: Command) {
  const repo = program.command('repo').description('Repository inspection helpers');

  repo
    .command('inspect')
    .description('Inspect a customer repo tree without modifying it')
    .requiredOption('--repo <path>', 'Repository root or parent folder')
    .option('--out <path>', 'Optional path to write the JSON context')
    .action((options) =>
      run(async () => {
        const resolved = resolve(options.repo);
        progress(`Inspecting repository context under ${resolved}`);
        const context = await inspectRepo(resolved);
        if (options.out) {
          await writeFile(resolve(options.out), JSON.stringify(context, null, 2));
          progress(`Wrote repository context to ${resolve(options.out)}`);
        }
        return context;
      }),
    );
}
