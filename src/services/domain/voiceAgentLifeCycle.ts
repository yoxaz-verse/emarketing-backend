import { supabase } from "../../supabase";

/**
 * Handle lifecycle rules BEFORE writing to voice_agents
 */
export async function handleVoiceAgentsBeforeWrite(
    payload: Record<string, any>,
    mode: 'create' | 'update',
    id?: string
) {
    if (mode === 'create') {
        // Enforce initial status if not provided
        if (!payload.status) {
            payload.status = 'active';
        }
        return payload;
    }

    if (mode === 'update' && id) {
        // 1. Fetch current status to enforce transition rules
        const { data: agent, error } = await supabase
            .from('voice_agents')
            .select('status')
            .eq('id', id)
            .single();

        if (error || !agent) return payload;

        const oldStatus = agent.status;
        const newStatus = payload.status;

        if (newStatus && newStatus !== oldStatus) {
            // retired → any (NOT allowed)
            if (oldStatus === 'retired') {
                throw new Error('Cannot change status of a retired agent');
            }

            // active → retired (NOT allowed)
            if (oldStatus === 'active' && newStatus === 'retired') {
                throw new Error('Active agents cannot be retired directly. Please pause them first.');
            }

            // 🔒 LOG EVENT
            await supabase.from('system_events').insert({
                type: 'voice_agent_status_changed',
                entity: 'voice_agent',
                entity_id: id,
                message: `Voice Agent status changed to ${newStatus}`
            });

            // Valid transitions (implied by logic):
            // active -> paused (OK)
            // paused -> active (OK)
            // paused -> retired (OK)
        }
    }

    return payload;
}

/**
 * Block deletion of voice agents
 */
export async function handleVoiceAgentsBeforeDelete() {
    throw new Error('Voice agents cannot be deleted. Use status = retired.');
}

/**
 * Enrich voice agents with statistics after read
 */
export async function resolveVoiceAgentsRead(
    rows: any[]
): Promise<any[]> {
    if (!rows || rows.length === 0) return rows;

    const agentIds = rows.map(r => r.id);

    // 1. Aggregate stats from voice_calls
    const { data: stats, error } = await supabase
        .from('voice_calls')
        .select('voice_agent_id, duration_seconds, outcome, created_at')
        .in('voice_agent_id', agentIds);

    if (error) {
        // Fail silently or log error, but don't break the read
        console.error('[STATS RESOLVER ERROR]', error);
        return rows;
    }

    // 2. Build stats map
    const statsMap: Record<string, any> = {};
    stats?.forEach((call: any) => {
        const aid = call.voice_agent_id;
        if (!statsMap[aid]) {
            statsMap[aid] = {
                total_calls: 0,
                answered_calls: 0,
                total_duration: 0,
                last_active_at: null as string | null
            };
        }

        const s = statsMap[aid];
        s.total_calls++;

        if (call.outcome === 'answered') {
            s.answered_calls++;
        }

        s.total_duration += (call.duration_seconds || 0);

        // Track latest activity
        if (!s.last_active_at || new Date(call.created_at) > new Date(s.last_active_at)) {
            s.last_active_at = call.created_at;
        }
    });

    // 3. Attach to rows
    return rows.map(row => {
        const s = statsMap[row.id];
        return {
            ...row,
            total_calls: s?.total_calls || 0,
            answered_calls: s?.answered_calls || 0,
            avg_duration_seconds: s?.total_calls > 0 ? Math.round(s.total_duration / s.total_calls) : 0,
            last_active_at: s?.last_active_at || null
        };
    });
}
