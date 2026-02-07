import { supabase } from "../../supabase";
import { selectVoiceAgent } from "../domain/voiceAgentSelector";

/**
 * Orchestrates the initiation of an outbound voice call for a campaign.
 * Handles deterministic agent selection and attribution to voice_calls.
 */
export async function initiateCampaignVoiceCall(campaignLeadId: string) {
    // 1. Fetch Campaign Lead info
    const { data: lead, error: leadError } = await supabase
        .from('campaign_leads')
        .select(`
            id,
            campaign_id,
            lead_id,
            leads (
                id
            )
        `)
        .eq('id', campaignLeadId)
        .single();

    if (leadError || !lead) {
        throw new Error(`Campaign lead not found: ${leadError?.message || 'Unknown error'}`);
    }

    const campaignId = lead.campaign_id;

    // 2. Deterministic Agent Selection (Strategy: Lowest Current Active Calls)
    const voiceAgentId = await selectVoiceAgent(campaignId);

    // 3. Create Voice Call record (For Attribution and Auditability)
    const { data: voiceCall, error: callError } = await supabase
        .from('voice_calls')
        .insert({
            campaign_id: campaignId,
            lead_id: lead.lead_id,
            voice_agent_id: voiceAgentId,
            outcome: null // Initial state
        })
        .select('id')
        .single();

    if (callError || !voiceCall) {
        throw new Error(`Failed to create voice call record: ${callError.message}`);
    }

    // 4. Trigger Voice Engine (Pass attributes to existing originate flow)
    const VOICE_ENGINE_URL = process.env.VOICE_ENGINE_URL || 'http://localhost:3004';

    // Note: In a real scenario, we'd fetch the lead's phone number here.
    // Assuming 'leads' has a 'phone_number' column based on Voice Engine requirements.
    const { data: leadDetail } = await supabase
        .from('leads')
        .select('phone_number')
        .eq('id', lead.lead_id)
        .single();

    const phoneNumber = leadDetail?.phone_number || '+10000000000'; // Fallback if not found

    const response = await fetch(`${VOICE_ENGINE_URL}/voice/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            phoneNumber,
            campaignId,
            leadId: lead.lead_id,
            voiceCallId: voiceCall.id,
            voiceAgentId: voiceAgentId
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        console.error('[VOICE ENGINE CALL FAILED]', errText);
        throw new Error(`Voice Engine failed to initiate call: ${errText}`);
    }

    const result = await response.json();

    console.log('[VOICE CALL INITIATED]', {
        voiceCallId: voiceCall.id,
        voiceAgentId,
        jobUuid: result.jobUuid
    });

    return {
        success: true,
        voiceCallId: voiceCall.id,
        voiceAgentId,
        jobUuid: result.jobUuid
    };
}
