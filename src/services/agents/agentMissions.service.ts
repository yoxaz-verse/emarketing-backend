import { supabase } from '../../supabase';
import { ALLOWED_ROLE_KEYS, ALLOWED_TASK_TYPES, listAgentTasks } from './agentTasks.service';
import { createAgent, listAgents } from './agentIntegrations.service';

const ALLOWED_EXECUTION_POLICIES = ['scheduled', 'always_on', 'manual_approval'] as const;
const ALLOWED_OUTPUT_POLICIES = ['task_center_only'] as const;
const ALLOWED_CADENCE_TYPES = ['daily', 'weekly'] as const;
const ALLOWED_MISSION_STATUSES = ['queued', 'dispatched', 'completed', 'failed', 'skipped'] as const;

type AuthCtx = {
  userId?: string | null;
  operatorId?: string | null;
};

type CreateMissionInput = {
  agent_id?: string;
  name?: string;
  role_key?: string;
  task_type?: string;
  mission_goal?: string;
  instructions?: string;
  cadence_type?: string;
  cadence_value?: number;
  timezone?: string;
  next_run_at?: string | null;
  active?: boolean;
  execution_policy?: string;
  output_policy?: string;
  priority?: number;
  metadata?: Record<string, unknown>;
};

type UpdateMissionInput = Partial<CreateMissionInput> & {
  last_status?: string | null;
  last_run_at?: string | null;
  error_count?: number;
  consecutive_failures?: number;
};

function ensureEnum(name: string, value: string, allowed: readonly string[]) {
  if (!allowed.includes(value)) throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
}

function asObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return input as Record<string, unknown>;
}

function toIsoOrNull(input?: string | null): string | null {
  if (!input) return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) throw new Error('next_run_at must be a valid ISO date-time');
  return d.toISOString();
}

function nextScheduleFrom(baseIso: string, cadenceType: string, cadenceValue: number): string {
  const base = new Date(baseIso);
  const step = Math.max(1, Math.floor(cadenceValue || 1));
  if (cadenceType === 'weekly') {
    base.setUTCDate(base.getUTCDate() + step * 7);
  } else {
    base.setUTCDate(base.getUTCDate() + step);
  }
  return base.toISOString();
}

async function createTaskFromMission(mission: any, auth: AuthCtx, missionRunId: string) {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('agent_tasks')
    .insert({
      role_key: mission.role_key,
      task_type: mission.task_type,
      input: mission.instructions,
      status: 'pending',
      priority: mission.priority ?? 5,
      metadata: {
        ...(asObject(mission.metadata)),
        mission_id: mission.id,
        mission_run_id: missionRunId,
        execution_policy: mission.execution_policy,
      },
      created_by: auth.userId ?? null,
      operator_id: auth.operatorId ?? null,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function createMission(input: CreateMissionInput, auth: AuthCtx) {
  const agentId = String(input.agent_id ?? '').trim();
  const name = String(input.name ?? '').trim();
  const roleKey = String(input.role_key ?? '').trim();
  const taskType = String(input.task_type ?? '').trim();
  const missionGoal = String(input.mission_goal ?? '').trim();
  const instructions = String(input.instructions ?? '').trim();
  const cadenceType = String(input.cadence_type ?? 'daily').trim().toLowerCase();
  const cadenceValue = Number.isFinite(Number(input.cadence_value)) ? Math.max(1, Number(input.cadence_value)) : 1;
  const timezone = String(input.timezone ?? 'Asia/Kolkata').trim() || 'Asia/Kolkata';
  const executionPolicy = String(input.execution_policy ?? 'scheduled').trim().toLowerCase();
  const outputPolicy = String(input.output_policy ?? 'task_center_only').trim().toLowerCase();
  const priority = Number.isFinite(Number(input.priority)) ? Number(input.priority) : 5;
  const nextRunAt = toIsoOrNull(input.next_run_at ?? null) ?? new Date(Date.now() + 60 * 1000).toISOString();

  if (!agentId) throw new Error('agent_id is required');
  if (!name) throw new Error('name is required');
  if (!roleKey) throw new Error('role_key is required');
  if (!taskType) throw new Error('task_type is required');
  if (!missionGoal) throw new Error('mission_goal is required');
  if (!instructions) throw new Error('instructions is required');

  ensureEnum('role_key', roleKey, ALLOWED_ROLE_KEYS);
  ensureEnum('task_type', taskType, ALLOWED_TASK_TYPES);
  ensureEnum('cadence_type', cadenceType, ALLOWED_CADENCE_TYPES);
  ensureEnum('execution_policy', executionPolicy, ALLOWED_EXECUTION_POLICIES);
  ensureEnum('output_policy', outputPolicy, ALLOWED_OUTPUT_POLICIES);

  const payload = {
    agent_id: agentId,
    name,
    role_key: roleKey,
    task_type: taskType,
    mission_goal: missionGoal,
    instructions,
    cadence_type: cadenceType,
    cadence_value: cadenceValue,
    timezone,
    next_run_at: nextRunAt,
    active: input.active ?? true,
    execution_policy: executionPolicy,
    output_policy: outputPolicy,
    priority,
    metadata: asObject(input.metadata),
    created_by: auth.userId ?? null,
    operator_id: auth.operatorId ?? null,
  };

  const { data, error } = await supabase.from('agent_missions').insert(payload).select('*').single();
  if (error) throw error;
  return data;
}

export async function listMissions(agentId?: string) {
  let query = supabase.from('agent_missions').select('*').order('created_at', { ascending: false });
  if (agentId) query = query.eq('agent_id', agentId);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function updateMission(missionId: string, input: UpdateMissionInput) {
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (input.name !== undefined) updates.name = String(input.name ?? '').trim();
  if (input.mission_goal !== undefined) updates.mission_goal = String(input.mission_goal ?? '').trim();
  if (input.instructions !== undefined) updates.instructions = String(input.instructions ?? '').trim();
  if (input.active !== undefined) updates.active = Boolean(input.active);
  if (input.next_run_at !== undefined) updates.next_run_at = toIsoOrNull(input.next_run_at);
  if (input.timezone !== undefined) updates.timezone = String(input.timezone ?? '').trim() || 'Asia/Kolkata';
  if (input.priority !== undefined) updates.priority = Number(input.priority);
  if (input.metadata !== undefined) updates.metadata = asObject(input.metadata);
  if (input.cadence_type !== undefined) {
    const cadenceType = String(input.cadence_type).trim().toLowerCase();
    ensureEnum('cadence_type', cadenceType, ALLOWED_CADENCE_TYPES);
    updates.cadence_type = cadenceType;
  }
  if (input.cadence_value !== undefined) updates.cadence_value = Math.max(1, Number(input.cadence_value));
  if (input.execution_policy !== undefined) {
    const value = String(input.execution_policy).trim().toLowerCase();
    ensureEnum('execution_policy', value, ALLOWED_EXECUTION_POLICIES);
    updates.execution_policy = value;
  }
  if (input.output_policy !== undefined) {
    const value = String(input.output_policy).trim().toLowerCase();
    ensureEnum('output_policy', value, ALLOWED_OUTPUT_POLICIES);
    updates.output_policy = value;
  }
  if (input.last_status !== undefined) {
    const value = String(input.last_status ?? '').trim().toLowerCase();
    if (value) ensureEnum('last_status', value, ALLOWED_MISSION_STATUSES);
    updates.last_status = value || null;
  }
  if (input.last_run_at !== undefined) updates.last_run_at = toIsoOrNull(input.last_run_at);
  if (input.error_count !== undefined) updates.error_count = Math.max(0, Number(input.error_count));
  if (input.consecutive_failures !== undefined) {
    updates.consecutive_failures = Math.max(0, Number(input.consecutive_failures));
  }

  const { data, error } = await supabase
    .from('agent_missions')
    .update(updates)
    .eq('id', missionId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function runMissionNow(missionId: string, auth: AuthCtx) {
  const { data: mission, error } = await supabase.from('agent_missions').select('*').eq('id', missionId).single();
  if (error) throw error;

  const runKey = `manual:${Date.now()}`;
  const nowIso = new Date().toISOString();
  const { data: run, error: runError } = await supabase
    .from('agent_mission_runs')
    .insert({
      mission_id: missionId,
      run_key: runKey,
      scheduled_for: nowIso,
      started_at: nowIso,
      status: 'queued',
      metadata: { trigger: 'manual' },
    })
    .select('*')
    .single();
  if (runError) throw runError;

  const task = await createTaskFromMission(mission, auth, run.id);

  await supabase
    .from('agent_mission_runs')
    .update({
      created_task_id: task.id,
      status: 'dispatched',
      updated_at: new Date().toISOString(),
    })
    .eq('id', run.id);

  return { mission, runId: run.id, taskId: task.id };
}

export async function dispatchDueMissions(limit = 20) {
  const nowIso = new Date().toISOString();
  const { data: missions, error } = await supabase
    .from('agent_missions')
    .select('*')
    .eq('active', true)
    .eq('execution_policy', 'scheduled')
    .lte('next_run_at', nowIso)
    .order('next_run_at', { ascending: true })
    .limit(limit);
  if (error) throw error;

  const due = missions ?? [];
  for (const mission of due) {
    const scheduledFor = String(mission.next_run_at || nowIso);
    const runKey = `sched:${scheduledFor}`;

    const { data: run, error: runError } = await supabase
      .from('agent_mission_runs')
      .insert({
        mission_id: mission.id,
        run_key: runKey,
        scheduled_for: scheduledFor,
        started_at: nowIso,
        status: 'queued',
        metadata: { trigger: 'scheduler' },
      })
      .select('*')
      .single();

    if (runError) {
      if (String(runError.message || '').toLowerCase().includes('duplicate key')) {
        await supabase
          .from('agent_missions')
          .update({
            next_run_at: nextScheduleFrom(scheduledFor, mission.cadence_type || 'daily', mission.cadence_value || 1),
            updated_at: nowIso,
          })
          .eq('id', mission.id);
        continue;
      }
      throw runError;
    }

    try {
      const task = await createTaskFromMission(mission, {}, run.id);

      await supabase.from('agent_mission_runs').update({
        created_task_id: task.id,
        status: 'dispatched',
        updated_at: new Date().toISOString(),
      }).eq('id', run.id);

      await supabase.from('agent_missions').update({
        last_run_at: nowIso,
        next_run_at: nextScheduleFrom(scheduledFor, mission.cadence_type || 'daily', mission.cadence_value || 1),
        last_status: 'dispatched',
        updated_at: nowIso,
      }).eq('id', mission.id);
    } catch (dispatchError) {
      const msg = dispatchError instanceof Error ? dispatchError.message : 'dispatch failed';
      await supabase.from('agent_mission_runs').update({
        status: 'failed',
        error: msg,
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', run.id);

      await supabase.from('agent_missions').update({
        last_status: 'failed',
        error_count: Number(mission.error_count || 0) + 1,
        consecutive_failures: Number(mission.consecutive_failures || 0) + 1,
        updated_at: new Date().toISOString(),
      }).eq('id', mission.id);
    }
  }
}

export async function updateMissionRunFromTaskResult(taskId: string, status: 'completed' | 'failed', resultText: string) {
  const { data: task, error } = await supabase
    .from('agent_tasks')
    .select('id,metadata,error')
    .eq('id', taskId)
    .single();
  if (error || !task) return;

  const metadata = asObject(task.metadata);
  const missionRunId = String(metadata.mission_run_id ?? '').trim();
  const missionId = String(metadata.mission_id ?? '').trim();
  if (!missionRunId || !missionId) return;

  const nowIso = new Date().toISOString();
  await supabase
    .from('agent_mission_runs')
    .update({
      status,
      result_summary: String(resultText || '').slice(0, 1000),
      error: status === 'failed' ? String(task.error ?? resultText ?? 'Task failed').slice(0, 1000) : null,
      finished_at: nowIso,
      updated_at: nowIso,
    })
    .eq('id', missionRunId);

  const { data: mission } = await supabase
    .from('agent_missions')
    .select('error_count,consecutive_failures')
    .eq('id', missionId)
    .single();

  if (status === 'completed') {
    await supabase
      .from('agent_missions')
      .update({
        last_status: 'completed',
        consecutive_failures: 0,
        updated_at: nowIso,
      })
      .eq('id', missionId);
  } else {
    await supabase
      .from('agent_missions')
      .update({
        last_status: 'failed',
        error_count: Number(mission?.error_count || 0) + 1,
        consecutive_failures: Number(mission?.consecutive_failures || 0) + 1,
        updated_at: nowIso,
      })
      .eq('id', missionId);
  }
}

export async function listMissionRuns(missionId: string, limit = 20) {
  const { data, error } = await supabase
    .from('agent_mission_runs')
    .select('*')
    .eq('mission_id', missionId)
    .order('created_at', { ascending: false })
    .limit(Math.max(1, Math.min(100, limit)));
  if (error) throw error;
  return data ?? [];
}

export async function getAgentRuntimeOverview() {
  const [{ data: agents, error: aErr }, { data: missions, error: mErr }] = await Promise.all([
    supabase.from('agents').select('*').order('created_at', { ascending: false }),
    supabase.from('agent_missions').select('*').order('created_at', { ascending: false }),
  ]);
  if (aErr) throw aErr;
  if (mErr) throw mErr;

  const tasks = await listAgentTasks({ limit: 200 });
  const roleLatestTask = new Map<string, any>();
  for (const task of tasks) {
    const key = String(task.role_key || '').trim();
    if (!key) continue;
    const existing = roleLatestTask.get(key);
    if (!existing || Date.parse(task.created_at) > Date.parse(existing.created_at)) {
      roleLatestTask.set(key, task);
    }
  }

  const byAgentId = new Map<string, any[]>();
  for (const mission of missions ?? []) {
    const key = String(mission.agent_id || '');
    const arr = byAgentId.get(key) ?? [];
    arr.push(mission);
    byAgentId.set(key, arr);
  }

  return (agents ?? []).map((agent: any) => {
    const missionList = byAgentId.get(agent.id) ?? [];
    const activeMissions = missionList.filter((m) => m.active);
    const nextRunAt = activeMissions
      .map((m) => m.next_run_at)
      .filter(Boolean)
      .sort()[0] ?? null;
    const latestTask = agent.role_key ? roleLatestTask.get(agent.role_key) ?? null : null;
    return {
      ...agent,
      missions: missionList,
      mission_count: missionList.length,
      active_mission_count: activeMissions.length,
      next_run_at: nextRunAt,
      latest_task: latestTask,
    };
  });
}

export function getMissionTemplates() {
  return [
    {
      name: 'Content Research Daily',
      role_key: 'research_agent',
      task_type: 'research',
      mission_goal: 'Track daily agro-trade developments and surface actionable insights.',
      instructions:
        'Research top agro-trade developments for today relevant to OBAOL users. Return concise insights, risks, and one content opportunity.',
      cadence_type: 'daily',
      cadence_value: 1,
      timezone: 'Asia/Kolkata',
      priority: 4,
    },
    {
      name: 'Content Creation Daily',
      role_key: 'content_creator',
      task_type: 'content_creation',
      mission_goal: 'Produce one high-quality daily content asset.',
      instructions:
        'Create one platform-ready content output for today based on current OBAOL priorities and yesterday insights.',
      cadence_type: 'daily',
      cadence_value: 1,
      timezone: 'Asia/Kolkata',
      priority: 5,
    },
    {
      name: 'Content Review Daily',
      role_key: 'social_post_creator',
      task_type: 'social_post',
      mission_goal: 'Refine and adapt drafts for publishing channels.',
      instructions:
        'Review drafted content, improve clarity and CTA, and provide LinkedIn + WhatsApp channel-ready variants.',
      cadence_type: 'daily',
      cadence_value: 1,
      timezone: 'Asia/Kolkata',
      priority: 5,
    },
    {
      name: 'Lead Enrichment Daily',
      role_key: 'lead_enrichment_agent',
      task_type: 'lead_enrichment',
      mission_goal: 'Improve lead quality signals for outreach.',
      instructions:
        'Enrich available leads with practical qualification notes and segment tags for campaign execution.',
      cadence_type: 'daily',
      cadence_value: 1,
      timezone: 'Asia/Kolkata',
      priority: 6,
    },
    {
      name: 'Campaign Planning Weekly',
      role_key: 'email_sequence_creator',
      task_type: 'email_sequence',
      mission_goal: 'Generate weekly campaign sequence plans.',
      instructions:
        'Prepare a weekly campaign sequence plan with targeting angle, 3-step messaging, and CTA strategy.',
      cadence_type: 'weekly',
      cadence_value: 1,
      timezone: 'Asia/Kolkata',
      priority: 6,
    },
    {
      name: 'Performance Reporting Weekly',
      role_key: 'blog_writer',
      task_type: 'blog_draft',
      mission_goal: 'Summarize weekly outcomes and opportunities.',
      instructions:
        'Create a weekly performance summary with wins, bottlenecks, and next-week recommendations.',
      cadence_type: 'weekly',
      cadence_value: 1,
      timezone: 'Asia/Kolkata',
      priority: 7,
    },
  ];
}

export async function bootstrapEmployeeTeam(auth: AuthCtx) {
  const templates = getMissionTemplates();
  const existingAgents = await listAgents();
  const existingMissions = await listMissions();

  const byRole = new Map<string, any>();
  for (const agent of existingAgents) {
    const role = String(agent.role_key ?? '').trim();
    if (role && !byRole.has(role)) byRole.set(role, agent);
  }

  const summary = {
    agents_created: 0,
    agents_reused: 0,
    missions_created: 0,
    missions_reused: 0,
    team: [] as Array<{ role_key: string; agent_id: string; mission_id: string }>,
  };

  for (const template of templates) {
    let agent = byRole.get(template.role_key);
    if (!agent) {
      const created = await createAgent({
        name: template.name.replace(/\s+(Daily|Weekly)$/i, ''),
        provider: 'openclaw',
        provider_type: 'custom',
        role_key: template.role_key,
        default_model: 'gpt-5.4',
        status: 'active',
      } as any);
      agent = created;
      byRole.set(template.role_key, created);
      summary.agents_created += 1;
    } else {
      summary.agents_reused += 1;
    }

    const existingMission = existingMissions.find(
      (m: any) =>
        String(m.agent_id) === String(agent.id) &&
        String(m.role_key) === template.role_key &&
        String(m.task_type) === template.task_type &&
        String(m.name) === template.name
    );

    let missionId = '';
    if (!existingMission) {
      const createdMission = await createMission(
        {
          agent_id: String(agent.id),
          name: template.name,
          role_key: template.role_key,
          task_type: template.task_type,
          mission_goal: template.mission_goal,
          instructions: template.instructions,
          cadence_type: template.cadence_type,
          cadence_value: template.cadence_value,
          timezone: template.timezone,
          next_run_at: new Date(Date.now() + 60 * 1000).toISOString(),
          active: true,
          execution_policy: 'scheduled',
          output_policy: 'task_center_only',
          priority: template.priority,
          metadata: { bootstrap: 'employee_team_v1' },
        },
        auth
      );
      missionId = createdMission.id;
      summary.missions_created += 1;
    } else {
      missionId = existingMission.id;
      summary.missions_reused += 1;
    }

    summary.team.push({
      role_key: template.role_key,
      agent_id: String(agent.id),
      mission_id: String(missionId),
    });
  }

  return summary;
}
