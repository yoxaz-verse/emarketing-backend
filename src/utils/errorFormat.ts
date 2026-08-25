export type FormattedError = {
  message: string;
  name?: string;
  code?: string;
  status?: number;
  hint?: string;
  details?: string;
  cause?: FormattedError;
};

function asRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object') return null;
  return input as Record<string, unknown>;
}

function stringValue(input: unknown): string | undefined {
  if (typeof input === 'string' && input.trim()) return input;
  if (typeof input === 'number' && Number.isFinite(input)) return String(input);
  return undefined;
}

function numberValue(input: unknown): number | undefined {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input === 'string' && input.trim() && Number.isFinite(Number(input))) return Number(input);
  return undefined;
}

export function formatUnknownError(error: unknown): FormattedError {
  const record = asRecord(error);
  const fallbackMessage = (() => {
    try {
      return String(error);
    } catch {
      return 'Unknown error';
    }
  })();

  const formatted: FormattedError = {
    message: stringValue(record?.message) ?? fallbackMessage,
  };

  const name = stringValue(record?.name);
  const code = stringValue(record?.code);
  const status = numberValue(record?.status);
  const hint = stringValue(record?.hint);
  const details = stringValue(record?.details);

  if (name) formatted.name = name;
  if (code) formatted.code = code;
  if (status !== undefined) formatted.status = status;
  if (hint) formatted.hint = hint;
  if (details) formatted.details = details;
  if (record?.cause) formatted.cause = formatUnknownError(record.cause);

  return formatted;
}

export function isSchemaDriftError(error: unknown): boolean {
  const formatted = formatUnknownError(error);
  const code = String(formatted.code ?? '').toUpperCase();
  const text = [
    formatted.message,
    formatted.details,
    formatted.hint,
    formatted.cause?.message,
    formatted.cause?.details,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return (
    code === '42P01' ||
    code === '42703' ||
    code === 'PGRST205' ||
    text.includes('does not exist') ||
    text.includes('schema cache') ||
    text.includes('column')
  );
}

export function isConnectivityError(error: unknown): boolean {
  const formatted = formatUnknownError(error);
  const code = String(formatted.code ?? formatted.cause?.code ?? '').toUpperCase();
  const text = [
    formatted.message,
    formatted.details,
    formatted.hint,
    formatted.cause?.message,
    formatted.cause?.details,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    text.includes('fetch failed') ||
    text.includes('getaddrinfo') ||
    text.includes('network') ||
    text.includes('timeout')
  );
}

export function isSupabaseAuthConfigError(error: unknown): boolean {
  const formatted = formatUnknownError(error);
  const code = String(formatted.code ?? formatted.cause?.code ?? '').toUpperCase();
  const text = [
    formatted.message,
    formatted.details,
    formatted.hint,
    formatted.cause?.message,
    formatted.cause?.details,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return (
    code === 'INVALID_API_KEY' ||
    code === 'API_KEY_INVALID' ||
    text.includes('unregistered api key') ||
    text.includes('invalid api key') ||
    text.includes('api key is invalid') ||
    text.includes('invalid jwt') ||
    text.includes('jwt malformed') ||
    text.includes('project not found')
  );
}
