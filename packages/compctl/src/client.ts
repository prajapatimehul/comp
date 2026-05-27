export type JsonObject = Record<string, unknown>;

export interface GlobalOptions {
  apiUrl?: string;
  apiKey?: string;
}

export interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  apiUrl?: string;
  apiKey?: string;
  bootstrapToken?: string;
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly code = 'CLI_ERROR',
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function apiRequest(path: string, options: ApiRequestOptions = {}) {
  const apiUrl = (options.apiUrl ?? process.env.COMP_API_URL ?? 'http://localhost:3333').replace(
    /\/$/,
    '',
  );
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (options.apiKey) headers['X-API-Key'] = options.apiKey;
  if (options.bootstrapToken) headers['X-Compctl-Token'] = options.bootstrapToken;

  const response = await fetch(`${apiUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  const body = text ? safeJson(text) : null;
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'message' in body
        ? String((body as { message: unknown }).message)
        : response.statusText;
    throw new ApiError(response.status, message, body);
  }
  return body;
}

export function requireApiKey(globals: GlobalOptions): string {
  const apiKey = globals.apiKey ?? process.env.COMP_API_KEY;
  if (!apiKey) {
    throw new CliError('Missing API key. Set COMP_API_KEY or pass --api-key.', 'MISSING_API_KEY');
  }
  return apiKey;
}

export function unwrapData(value: unknown): JsonObject | null {
  if (value && typeof value === 'object' && 'data' in value) {
    return (value as { data: JsonObject }).data;
  }
  return value && typeof value === 'object' ? (value as JsonObject) : null;
}

export function responseArray(value: unknown): unknown[] {
  const unwrapped = unwrapData(value);
  if (Array.isArray(unwrapped)) return unwrapped;
  if (
    unwrapped &&
    typeof unwrapped === 'object' &&
    Array.isArray((unwrapped as { data?: unknown }).data)
  ) {
    return (unwrapped as { data: unknown[] }).data;
  }
  if (value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)) {
    return (value as { data: unknown[] }).data;
  }
  return [];
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
