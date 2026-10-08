import { AllowedTable } from '../../config/allowedTables';
import { handleLeadReply } from '../handleReply';
import { handleApiKeyBeforeWrite } from './apiKeyLifeCycle';
import { handleCampaignLeadsBeforeWrite } from './campaignLeadsLifeCycle';
import { handleCampaignBeforeWrite } from './campaignLifeCycle';
import { handleInboxBeforeWrite } from './inboxLifeCycle';
import { handleLeadsBeforeWrite } from './leadLifeCycle';
import { handleSmtpAccountBeforeWrite } from './smtpAccountsLifeCycle';
import { handleUserBeforeWrite } from './userLifeCycle';
import { handleVoiceAgentsBeforeWrite } from './voiceAgentLifeCycle';
import { extractSequencePlaceholders } from '../campaignPersonalization.service';

export async function runBeforeWrite(
  table: AllowedTable,
  payload: Record<string, any>,
  mode: 'create' | 'update',
  id?: string
) {
  if (table === 'voice_agents') {
    return handleVoiceAgentsBeforeWrite(payload, mode, id);
  }
  if (table === 'users') {
    return handleUserBeforeWrite(payload, mode);
  }
  if (table === 'inboxes') {
    return handleInboxBeforeWrite(payload, mode, id);
  }

  if (table === 'campaigns') {
    return handleCampaignBeforeWrite(payload, mode);
  }
  if (table === 'smtp_accounts') {
    return handleSmtpAccountBeforeWrite(payload, mode, id);
  }

  if (table === 'leads') {
    return handleLeadsBeforeWrite(payload, mode);
  }
  if (table === 'api_keys') {
    return handleApiKeyBeforeWrite(payload, mode);
  }
  if (table === 'campaign_leads') {
    return handleCampaignLeadsBeforeWrite(payload, mode);
  }
  if (table === 'sequence_steps') {
    try {
      extractSequencePlaceholders([{
        subject: payload.subject,
        body: payload.body,
        step_number: payload.step_number,
      }]);
    } catch (error) {
      const invalidTemplate = new Error(error instanceof Error ? error.message : 'Invalid dynamic field syntax.') as Error & { statusCode?: number };
      invalidTemplate.statusCode = 400;
      throw invalidTemplate;
    }
  }

  return payload;
}
