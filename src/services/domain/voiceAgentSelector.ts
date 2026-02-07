import { supabase } from "../../supabase";

/**
 * Deterministic Voice Agent Selector
 * ----------------------------------
 * Purpose: Selects exactly ONE voice agent for a campaign call.
 * Logic:
 * 1. Filter: Agent must be 'active' in voice_agents AND active=true in campaign_voice_agents.
 * 2. Selection: Pick agent with the lowest number of current active calls.
 * 3. Tie-breaker: Deterministic sort by ID.
 */
export async function selectVoiceAgent(campaignId: string): Promise<string> {
    // 1. Fetch all assigned and active voice agents for this campaign
    const { data: eligibleAgents, error: agentsError } = await supabase
        .from('campaign_voice_agents')
        .select(`
            voice_agent_id,
            voice_agents!inner (
                id,
                status
            )
        `)
        .eq('campaign_id', campaignId)
        .eq('active', true)
        .eq('voice_agents.status', 'active');

    if (agentsError) {
        throw new Error(`Failed to fetch eligible voice agents: ${agentsError.message}`);
    }

    if (!eligibleAgents || eligibleAgents.length === 0) {
        throw new Error('No active voice agents assigned to this campaign');
    }

    const agentIds = eligibleAgents.map((a: any) => a.voice_agent_id);

    // 2. Determine current active calls for these agents
    // We define "active call" as a record in voice_calls without an outcome or hangup timestamp
    // Assuming 'outcome' is null for active calls based on existing patterns
    const { data: activeCalls, error: callsError } = await supabase
        .from('voice_calls')
        .select('voice_agent_id')
        .in('voice_agent_id', agentIds)
        .is('outcome', null); // Active calls have no outcome yet

    if (callsError) {
        throw new Error(`Failed to fetch active call counts: ${callsError.message}`);
    }

    // 3. Aggregate counts
    const callCounts: Record<string, number> = {};
    agentIds.forEach((id: string) => callCounts[id] = 0);
    activeCalls?.forEach((call: any) => {
        if (callCounts[call.voice_agent_id] !== undefined) {
            callCounts[call.voice_agent_id]++;
        }
    });

    // 4. Deterministic Sort: Lowest count first, then by ID
    const sortedAgents = agentIds.sort((a: string, b: string) => {
        const diff = callCounts[a] - callCounts[b];
        if (diff !== 0) return diff;
        return a.localeCompare(b); // Deterministic tie-breaker
    });

    const selectedId = sortedAgents[0];

    console.log('[AGENT SELECTOR]', {
        campaignId,
        eligibleCount: agentIds.length,
        selectedId,
        activeCallCount: callCounts[selectedId]
    });

    return selectedId;
}
