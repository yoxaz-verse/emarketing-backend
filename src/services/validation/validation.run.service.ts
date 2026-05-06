import { supabase } from '../../supabase';

export type ValidationRunMode = 'pending' | 'rerun_failed';
export type ValidationRunStatus = 'queued' | 'running' | 'completed' | 'failed';
export type ValidationRunOutcome = 'valid' | 'risky' | 'invalid' | 'failed';

export type ValidationRunRow = {
  id: string;
  type: ValidationRunMode;
  status: ValidationRunStatus;
  started_at: string;
  finished_at: string | null;
  triggered_by: string | null;
  scope: Record<string, unknown> | null;
  total_targeted: number;
  processed_count: number;
  success_count: number;
  risky_count: number;
  invalid_count: number;
  failed_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

function deriveStatus(run: ValidationRunRow): 'idle' | 'queued' | 'running' | 'completed' | 'failed' {
  if (!run) return 'idle';
  return run.status;
}

export async function getActiveValidationRun(): Promise<ValidationRunRow | null> {
  const { data, error } = await supabase
    .from('validation_runs')
    .select('*')
    .in('status', ['queued', 'running'])
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return (data as ValidationRunRow | null) ?? null;
}

export async function createValidationRun(params: {
  type: ValidationRunMode;
  totalTargeted: number;
  triggeredBy?: string | null;
  scope?: Record<string, unknown>;
}): Promise<ValidationRunRow> {
  const { data, error } = await supabase
    .from('validation_runs')
    .insert({
      type: params.type,
      status: params.totalTargeted > 0 ? 'running' : 'completed',
      started_at: new Date().toISOString(),
      finished_at: params.totalTargeted > 0 ? null : new Date().toISOString(),
      total_targeted: params.totalTargeted,
      triggered_by: params.triggeredBy ?? null,
      scope: params.scope ?? {},
    })
    .select('*')
    .single();

  if (error) throw error;
  return data as ValidationRunRow;
}

export async function markRunOutcome(runId: string, outcome: ValidationRunOutcome): Promise<void> {
  const { data: run, error: fetchError } = await supabase
    .from('validation_runs')
    .select('*')
    .eq('id', runId)
    .single();

  if (fetchError || !run) return;

  const typed = run as ValidationRunRow;
  const processedCount = (typed.processed_count ?? 0) + 1;
  const patch: Record<string, unknown> = {
    processed_count: processedCount,
    updated_at: new Date().toISOString(),
  };

  if (outcome === 'valid') patch.success_count = (typed.success_count ?? 0) + 1;
  if (outcome === 'risky') patch.risky_count = (typed.risky_count ?? 0) + 1;
  if (outcome === 'invalid') patch.invalid_count = (typed.invalid_count ?? 0) + 1;
  if (outcome === 'failed') patch.failed_count = (typed.failed_count ?? 0) + 1;

  const done = processedCount >= (typed.total_targeted ?? 0);
  if (done) {
    patch.status = 'completed';
    patch.finished_at = new Date().toISOString();
  }

  await supabase
    .from('validation_runs')
    .update(patch)
    .eq('id', runId);
}

export async function markRunFailed(runId: string, errorMessage: string): Promise<void> {
  await supabase
    .from('validation_runs')
    .update({
      status: 'failed',
      finished_at: new Date().toISOString(),
      last_error: errorMessage,
      updated_at: new Date().toISOString(),
    })
    .eq('id', runId);
}

export async function getLatestValidationRun(): Promise<ValidationRunRow | null> {
  const { data, error } = await supabase
    .from('validation_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return (data as ValidationRunRow | null) ?? null;
}

export async function listValidationRuns(limit: number = 5): Promise<ValidationRunRow[]> {
  const safeLimit = Math.max(1, Math.min(20, limit));
  const { data, error } = await supabase
    .from('validation_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(safeLimit);

  if (error) throw error;
  return (data as ValidationRunRow[]) ?? [];
}

export function toValidationRunStatusPayload(run: ValidationRunRow | null) {
  if (!run) {
    return {
      status: 'idle',
      run: null,
      metrics: {
        totalTargeted: 0,
        processed: 0,
        remaining: 0,
        inProgress: 0,
        completionPercent: 0,
      },
    };
  }

  const totalTargeted = run.total_targeted ?? 0;
  const processed = run.processed_count ?? 0;
  const remaining = Math.max(0, totalTargeted - processed);
  const completionPercent = totalTargeted > 0 ? Math.round((processed / totalTargeted) * 100) : 100;

  return {
    status: deriveStatus(run),
    run,
    metrics: {
      totalTargeted,
      processed,
      remaining,
      inProgress: run.status === 'running' ? remaining : 0,
      completionPercent,
    },
  };
}
