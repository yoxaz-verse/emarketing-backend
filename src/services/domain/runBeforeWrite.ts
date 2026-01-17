import { AllowedTable } from '../../config/allowedTables';
import { handleLeadReply } from '../handleReply';
import { handleApiKeyBeforeWrite } from './apiKeyLifeCycle';
import { handleCampaignLeadsBeforeWrite } from './campaignLeadsLifeCycle';
import { handleCampaignBeforeWrite } from './campaignLifeCycle';
import { handleInboxBeforeWrite } from './inboxLifeCycle';
import { handleLeadsBeforeWrite } from './leadLifeCycle';
import { handleSmtpAccountBeforeWrite } from './smtpAccountsLifeCycle';
import { handleUserBeforeWrite } from './userLifeCycle';

export async function runBeforeWrite(
  table: AllowedTable,
  payload: Record<string, any>,
  mode: 'create' | 'update'
) {
  if (table === 'users') {
    return handleUserBeforeWrite(payload, mode);
  }
  if (table === 'inboxes') {
    return handleInboxBeforeWrite(payload, mode);
  }

  if (table === 'campaigns') {
    return handleCampaignBeforeWrite(payload, mode);
  }
  if (table === 'smtp_accounts') {
    return handleSmtpAccountBeforeWrite(payload, mode);
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

  return payload;
}
