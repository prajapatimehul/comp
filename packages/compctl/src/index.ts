import { Command } from 'commander';
import { awsCommand } from './commands/aws.js';
import { controlsCommand } from './commands/controls.js';
import { evidenceCommand } from './commands/evidence.js';
import { policiesCommand } from './commands/policies.js';
import { readinessCommand } from './commands/readiness.js';
import { registerCommand } from './commands/register.js';
import { repoCommand } from './commands/repo.js';
import { risksCommand } from './commands/risks.js';
import { tasksCommand } from './commands/tasks.js';
import { vendorsCommand } from './commands/vendors.js';
import { outputError } from './utils/output.js';

const program = new Command();

program
  .name('comp')
  .description('Agent-friendly Comp AI CLI for SOC 2 readiness workflows')
  .version('0.2.0')
  .option('--api-url <url>', 'Comp API URL', process.env.COMP_API_URL ?? 'http://localhost:3333')
  .option('--api-key <key>', 'Comp API key', process.env.COMP_API_KEY);

registerCommand(program);
repoCommand(program);
readinessCommand(program);
policiesCommand(program);
tasksCommand(program);
vendorsCommand(program);
risksCommand(program);
controlsCommand(program);
evidenceCommand(program);
awsCommand(program);

program.parseAsync().catch((error) => {
  outputError(error);
  process.exitCode = 1;
});
