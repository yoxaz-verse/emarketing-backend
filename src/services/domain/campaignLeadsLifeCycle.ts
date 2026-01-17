export async function handleCampaignLeadsBeforeWrite(
  payload: Record<string, any>,
  mode: 'create' | 'update'
) {
  /* ===============================
     REQUIRED FIELDS
  =============================== */

  console.log('payload :' ,payload);
  
  if (!payload.campaign_id) {
    throw new Error('campaign_id is required');
  }

  if (!payload.lead_id) {
    throw new Error('lead_id is required');
  }

  /* ===============================
     CREATE MODE
  =============================== */
  if (mode === 'create') {
    // Default status
    if (!payload.status) {
      payload.status = 'queued';
    }

    // 🔴 CRITICAL FIX
    // Ensure campaign always starts from step 1
    if (
      payload.current_step === undefined ||
      payload.current_step === null ||
      payload.current_step < 1
    ) {
      payload.current_step = 1;
    }

    return payload;
  }

  /* ===============================
     UPDATE MODE
  =============================== */
  if (mode === 'update') {
    // Never allow invalid step
    if (
      payload.current_step !== undefined &&
      payload.current_step < 1
    ) {
      throw new Error('current_step must be >= 1');
    }

    return payload;
  }

  return payload;
}
