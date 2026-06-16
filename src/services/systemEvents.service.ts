import { supabase } from '../supabase';

type SystemEventInput = {
  type: string;
  entity?: string | null;
  entity_id?: string | null;
  message?: string | null;
  meta?: Record<string, unknown> | null;
};

function isMissingMetaColumn(error: unknown): boolean {
  const message = String((error as any)?.message ?? '').toLowerCase();
  const code = String((error as any)?.code ?? '');
  return code === 'PGRST204' || message.includes('meta') && message.includes('column');
}

export async function insertSystemEvent(input: SystemEventInput): Promise<void> {
  const row = {
    type: input.type,
    entity: input.entity ?? null,
    entity_id: input.entity_id ?? null,
    message: input.message ?? input.type,
    ...(input.meta ? { meta: input.meta } : {}),
  };

  const { error } = await supabase.from('system_events').insert(row);
  if (!error) return;

  if (input.meta && isMissingMetaColumn(error)) {
    const fallbackRow = {
      type: input.type,
      entity: input.entity ?? null,
      entity_id: input.entity_id ?? null,
      message: input.message ?? input.type,
    };
    const { error: fallbackError } = await supabase.from('system_events').insert(fallbackRow);
    if (!fallbackError) return;
    console.warn('[SYSTEM_EVENT_INSERT_FALLBACK_FAILED]', fallbackError.message);
    return;
  }

  console.warn('[SYSTEM_EVENT_INSERT_FAILED]', error.message);
}
