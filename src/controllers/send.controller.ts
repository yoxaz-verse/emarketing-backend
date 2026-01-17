import { Request, Response } from 'express'
import { canSendEmail } from '../services/sending/preSendGate.service'
import { supabase } from '../supabase'

export async function preSendCheck(
  req: Request,
  res: Response
) {
  const { leadId, inboxId, domainId, campaignId } = req.body

  const { data: lead } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .single()

  const { data: inbox } = await supabase
    .from('inboxes')
    .select('*')
    .eq('id', inboxId)
    .single()

  const { data: domain } = await supabase
    .from('sending_domains')
    .select('*')
    .eq('id', domainId)
    .single()

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .single()

  const decision = canSendEmail({
    lead,
    inbox,
    domain,
    campaign,
  })

  return res.json({ decision })
}
