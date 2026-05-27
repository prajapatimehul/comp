import type { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { apiRequest, CliError, unwrapData, type GlobalOptions } from '../client.js';
import { progress, run } from '../utils/output.js';

export function registerCommand(program: Command) {
  program
    .command('register')
    .description('Register or reuse a client organization and mint an API key')
    .requiredOption('--company-name <name>', 'Company/client name')
    .requiredOption('--owner-email <email>', 'Owner email for the generated organization')
    .option('--owner-name <name>', 'Owner display name', 'Comp AI Agent')
    .option('--website <url>', 'Company website')
    .option('--framework <name>', 'Readiness framework name', 'SOC 2 Type 1')
    .option(
      '--api-key-out <path>',
      'Write the minted API key to a local file instead of printing it',
    )
    .option(
      '--bootstrap-token <token>',
      'Comp bootstrap token',
      process.env.COMPCTL_BOOTSTRAP_TOKEN ?? process.env.SERVICE_TOKEN_COMPCTL,
    )
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        if (!options.bootstrapToken) {
          throw new CliError(
            'Missing bootstrap token. Set COMPCTL_BOOTSTRAP_TOKEN or pass --bootstrap-token.',
            'MISSING_BOOTSTRAP_TOKEN',
          );
        }
        progress('Registering Comp AI client organization');
        const response = await apiRequest('/v1/readiness/register', {
          method: 'POST',
          apiUrl: globals.apiUrl,
          bootstrapToken: options.bootstrapToken,
          body: {
            companyName: options.companyName,
            ownerEmail: options.ownerEmail,
            ownerName: options.ownerName,
            website: options.website,
            framework: options.framework,
          },
        });
        await writeApiKeyIfRequested(response, options.apiKeyOut);
        return response;
      }),
    );
}

async function writeApiKeyIfRequested(response: unknown, outputPath?: string) {
  if (!outputPath) return;
  const data = unwrapData(response);
  const apiKey =
    data && typeof data === 'object' && 'apiKey' in data
      ? (data as { apiKey?: unknown }).apiKey
      : undefined;
  if (typeof apiKey !== 'string' || !apiKey) {
    throw new CliError(
      'Register response did not include an API key to write.',
      'MISSING_API_KEY_OUTPUT',
    );
  }
  const resolved = resolve(outputPath);
  await writeFile(resolved, `${apiKey}\n`, { mode: 0o600 });
  progress(`Wrote API key to ${resolved}`);
}
