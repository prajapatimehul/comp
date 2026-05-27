import type { Command } from 'commander';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { apiRequest, CliError, requireApiKey, safeJson, type GlobalOptions } from '../client.js';
import { progress, run } from '../utils/output.js';

const execFileAsync = promisify(execFile);

export function awsCommand(program: Command) {
  const aws = program.command('aws').description('AWS connection and scan commands');

  aws
    .command('setup-role')
    .description('Create or update the read-only Comp AI IAM role using direct AWS CLI')
    .requiredOption('--external-id <id>', 'External ID, usually the Comp organization ID')
    .requiredOption('--principal-arn <arn>', 'Comp role assumer principal ARN')
    .option('--profile <profile>', 'AWS CLI profile', process.env.AWS_PROFILE)
    .option('--region <region>', 'AWS region', process.env.AWS_REGION ?? 'us-east-1')
    .option('--role-name <name>', 'IAM role name', 'CompAI-Auditor')
    .option('--dry-run', 'Return the planned AWS CLI actions without executing')
    .action((options) =>
      run(async () => {
        progress('Setting up Comp AI AWS IAM role with direct AWS CLI');
        return setupAwsRole({
          externalId: options.externalId,
          principalArn: options.principalArn,
          profile: options.profile,
          region: options.region,
          roleName: options.roleName,
          dryRun: options.dryRun === true,
        });
      }),
    );

  aws
    .command('connect')
    .description('Create or reuse an AWS integration connection in Comp AI')
    .requiredOption('--role-arn <arn>', 'AWS IAM role ARN created by aws setup-role')
    .option('--external-id <id>', 'External ID; defaults to current Comp organization ID')
    .option('--regions <regions>', 'Comma-separated regions to scan', 'eu-central-1')
    .option('--connection-name <name>', 'Comp connection name', 'Helvetia AWS')
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        const apiKey = requireApiKey(globals);
        const status = await apiRequest('/v1/readiness/status', {
          apiUrl: globals.apiUrl,
          apiKey,
        });
        const org = (status as { data?: { organization?: { id?: string } } })?.data?.organization;
        const organizationId = options.externalId ?? org?.id;
        if (!organizationId) {
          throw new CliError(
            'Could not infer organization ID. Pass --external-id.',
            'MISSING_EXTERNAL_ID',
          );
        }

        const regions = options.regions
          .split(',')
          .map((r: string) => r.trim())
          .filter(Boolean);
        progress('Creating or reusing AWS connection in Comp AI');
        return connectAws({
          apiUrl: globals.apiUrl,
          apiKey,
          roleArn: options.roleArn,
          externalId: organizationId,
          regions,
          connectionName: options.connectionName,
        });
      }),
    );

  aws
    .command('scan')
    .description('Run a Comp AI cloud scan for an AWS connection')
    .option('--connection-id <id>', 'AWS connection ID to scan')
    .action((options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        const apiKey = requireApiKey(globals);
        progress('Running Comp AI AWS cloud scan');
        return scanAws({
          apiUrl: globals.apiUrl,
          apiKey,
          connectionId: options.connectionId,
        });
      }),
    );

  aws
    .command('findings')
    .description('Read cloud security findings from Comp AI')
    .action((_options, command) =>
      run(async () => {
        const globals = command.optsWithGlobals() as GlobalOptions;
        progress('Reading cloud findings from Comp AI');
        return apiRequest('/v1/cloud-security/findings', {
          apiUrl: globals.apiUrl,
          apiKey: requireApiKey(globals),
        });
      }),
    );
}

interface AwsRoleOptions {
  externalId: string;
  principalArn: string;
  profile?: string;
  region: string;
  roleName: string;
  dryRun: boolean;
}

async function setupAwsRole(options: AwsRoleOptions) {
  const trustPolicy = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: options.principalArn },
        Action: 'sts:AssumeRole',
        Condition: { StringEquals: { 'sts:ExternalId': options.externalId } },
      },
    ],
  };
  const costExplorerPolicy = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: 'ce:GetCostAndUsage', Resource: '*' }],
  };
  const extraReadPolicy = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['ssm:GetDocument', 'ssm:DescribeDocument', 'ssm:ListDocuments'],
        Resource: '*',
      },
    ],
  };

  const plannedActions = [
    'sts get-caller-identity',
    `iam get-role --role-name ${options.roleName}`,
    `iam create-role/update-assume-role-policy --role-name ${options.roleName}`,
    `iam attach-role-policy SecurityAudit`,
    `iam attach-role-policy ViewOnlyAccess`,
    `iam put-role-policy CompAI-CostExplorer`,
    `iam put-role-policy CompAI-ExtraReadAccess`,
  ];
  if (options.dryRun) {
    return { dryRun: true, plannedActions, trustPolicy };
  }

  const identity = await awsJson(['sts', 'get-caller-identity'], options);
  const accountId = String((identity as { Account?: string }).Account ?? '');
  const roleArn = `arn:aws:iam::${accountId}:role/${options.roleName}`;
  const trustFile = await writeTempJson(trustPolicy);
  const ceFile = await writeTempJson(costExplorerPolicy);
  const extraFile = await writeTempJson(extraReadPolicy);

  try {
    const existing = await awsJson(
      ['iam', 'get-role', '--role-name', options.roleName],
      options,
    ).catch(() => null);
    if (existing) {
      await awsJson(
        [
          'iam',
          'update-assume-role-policy',
          '--role-name',
          options.roleName,
          '--policy-document',
          `file://${trustFile.path}`,
        ],
        options,
      );
    } else {
      await awsJson(
        [
          'iam',
          'create-role',
          '--role-name',
          options.roleName,
          '--max-session-duration',
          '43200',
          '--assume-role-policy-document',
          `file://${trustFile.path}`,
        ],
        options,
      );
    }

    await awsJson(
      [
        'iam',
        'attach-role-policy',
        '--role-name',
        options.roleName,
        '--policy-arn',
        'arn:aws:iam::aws:policy/SecurityAudit',
      ],
      options,
    );
    await awsJson(
      [
        'iam',
        'attach-role-policy',
        '--role-name',
        options.roleName,
        '--policy-arn',
        'arn:aws:iam::aws:policy/job-function/ViewOnlyAccess',
      ],
      options,
    );
    await awsJson(
      [
        'iam',
        'put-role-policy',
        '--role-name',
        options.roleName,
        '--policy-name',
        'CompAI-CostExplorer',
        '--policy-document',
        `file://${ceFile.path}`,
      ],
      options,
    );
    await awsJson(
      [
        'iam',
        'put-role-policy',
        '--role-name',
        options.roleName,
        '--policy-name',
        'CompAI-ExtraReadAccess',
        '--policy-document',
        `file://${extraFile.path}`,
      ],
      options,
    );

    return {
      roleArn,
      externalId: options.externalId,
      principalArn: options.principalArn,
      awsAccountId: accountId,
      region: options.region,
      roleName: options.roleName,
      plannedActions,
    };
  } finally {
    await Promise.all([trustFile.cleanup(), ceFile.cleanup(), extraFile.cleanup()]);
  }
}

async function connectAws(params: {
  apiUrl?: string;
  apiKey: string;
  roleArn: string;
  externalId: string;
  regions: string[];
  connectionName: string;
}) {
  const existing = await apiRequest('/v1/integrations/connections', {
    apiUrl: params.apiUrl,
    apiKey: params.apiKey,
  });
  const connections = Array.isArray(existing) ? existing : [];
  const credentials = {
    connectionName: params.connectionName,
    roleArn: params.roleArn,
    externalId: params.externalId,
    regions: params.regions,
  };
  const match = connections.find((connection) => {
    const item = connection as {
      id?: string;
      providerSlug?: string;
      metadata?: { roleArn?: string };
      status?: string;
    };
    return (
      item.providerSlug === 'aws' &&
      item.metadata?.roleArn === params.roleArn &&
      item.status !== 'disconnected'
    );
  });
  if (match) {
    const item = match as { id?: string; status?: string };
    if (item.status === 'active') {
      return { reused: true, connection: match };
    }
    if (!item.id) {
      throw new CliError('Matched AWS connection is missing an id.', 'INVALID_CONNECTION');
    }
    await apiRequest(`/v1/integrations/connections/${item.id}/credentials`, {
      method: 'PUT',
      apiUrl: params.apiUrl,
      apiKey: params.apiKey,
      body: { credentials },
    });
    const repaired = await apiRequest(`/v1/integrations/connections/${item.id}`, {
      apiUrl: params.apiUrl,
      apiKey: params.apiKey,
    });
    return { reused: true, repaired: true, connection: repaired };
  }

  const created = await apiRequest('/v1/integrations/connections', {
    method: 'POST',
    apiUrl: params.apiUrl,
    apiKey: params.apiKey,
    body: { providerSlug: 'aws', credentials },
  });
  return { reused: false, connection: created };
}

async function scanAws(params: { apiUrl?: string; apiKey: string; connectionId?: string }) {
  let connectionId = params.connectionId;
  if (!connectionId) {
    const existing = await apiRequest('/v1/integrations/connections', {
      apiUrl: params.apiUrl,
      apiKey: params.apiKey,
    });
    const awsConnections = Array.isArray(existing)
      ? existing.filter(
          (connection) =>
            (connection as { providerSlug?: string }).providerSlug === 'aws' &&
            (connection as { status?: string }).status === 'active',
        )
      : [];
    if (awsConnections.length === 0) {
      throw new CliError(
        'No active AWS connection found. Run comp aws connect first.',
        'NO_AWS_CONNECTION',
      );
    }
    connectionId = String((awsConnections[0] as { id: string }).id);
  }

  let detectedServices: unknown = null;
  try {
    detectedServices = await apiRequest(`/v1/cloud-security/detect-services/${connectionId}`, {
      method: 'POST',
      apiUrl: params.apiUrl,
      apiKey: params.apiKey,
    });
  } catch (error) {
    progress(
      `Service detection skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const scan = await apiRequest(`/v1/cloud-security/scan/${connectionId}`, {
    method: 'POST',
    apiUrl: params.apiUrl,
    apiKey: params.apiKey,
  });
  const findings = await apiRequest('/v1/cloud-security/findings', {
    apiUrl: params.apiUrl,
    apiKey: params.apiKey,
  });

  return { connectionId, detectedServices, scan, findings };
}

async function awsJson(args: string[], options: Pick<AwsRoleOptions, 'profile' | 'region'>) {
  const finalArgs = [...args, '--region', options.region, '--output', 'json'];
  if (options.profile) finalArgs.push('--profile', options.profile);
  const { stdout, stderr } = await execFileAsync('aws', finalArgs, { maxBuffer: 10 * 1024 * 1024 });
  if (stderr.trim()) progress(stderr.trim());
  return stdout.trim() ? safeJson(stdout) : {};
}

async function writeTempJson(value: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'comp-'));
  const path = join(dir, 'document.json');
  await writeFile(path, JSON.stringify(value));
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
