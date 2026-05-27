import { ApiError, CliError, unwrapData } from '../client.js';

export async function run(fn: () => Promise<unknown>) {
  try {
    const data = await fn();
    outputSuccess(data);
  } catch (error) {
    outputError(error);
    process.exitCode = 1;
  }
}

export function outputSuccess(data: unknown) {
  console.log(
    JSON.stringify(redactSecrets({ success: true, data: unwrapData(data) ?? data }), null, 2),
  );
}

export function outputError(error: unknown) {
  if (error instanceof ApiError) {
    console.log(
      JSON.stringify(
        redactSecrets({
          success: false,
          error: {
            code: 'API_ERROR',
            status: error.status,
            message: error.message,
            details: error.details,
          },
        }),
        null,
        2,
      ),
    );
    return;
  }

  if (error instanceof CliError) {
    console.log(
      JSON.stringify(
        redactSecrets({
          success: false,
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
        }),
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    JSON.stringify(
      redactSecrets({
        success: false,
        error: {
          code: 'UNEXPECTED_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      }),
      null,
      2,
    ),
  );
}

export function progress(message: string) {
  process.stderr.write(`[comp] ${message}\n`);
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (!value || typeof value !== 'object') return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/api[-_]?key|token|secret|password|access[-_]?key|session/i.test(key)) {
      redacted[key] = '[redacted]';
    } else {
      redacted[key] = redactSecrets(nested);
    }
  }
  return redacted;
}
