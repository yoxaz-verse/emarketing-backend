import { Router } from 'express';
import { supabase } from '../supabase';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const { data: folders, error } = await supabase
      .from('lead_folders')
      .select('id,name,operator_id,created_at,updated_at')
      .order('name', { ascending: true });

    if (error) throw error;
    const folderIds = (folders ?? []).map((f: any) => f.id);

    let countsByFolder = new Map<string, number>();
    if (folderIds.length > 0) {
      const { data: assignedLeads, error: assignedLeadsError } = await supabase
        .from('leads')
        .select('folder_id')
        .in('folder_id', folderIds);
      if (assignedLeadsError) throw assignedLeadsError;
      for (const lead of assignedLeads ?? []) {
        if (!lead.folder_id) continue;
        countsByFolder.set(lead.folder_id, (countsByFolder.get(lead.folder_id) ?? 0) + 1);
      }
    }

    return res.json({
      success: true,
      folders: (folders ?? []).map((folder: any) => ({
        ...folder,
        lead_count: countsByFolder.get(folder.id) ?? 0,
      })),
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message ?? 'Failed to list folders' });
  }
});

router.post('/', async (req, res) => {
  try {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'name is required' });

    const { data, error } = await supabase
      .from('lead_folders')
      .insert({ name })
      .select('id,name,operator_id,created_at,updated_at')
      .single();
    if (error) throw error;
    return res.json({ success: true, folder: { ...data, lead_count: 0 } });
  } catch (err: any) {
    return res.status(400).json({ success: false, error: err.message ?? 'Failed to create folder' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'name is required' });
    const { data, error } = await supabase
      .from('lead_folders')
      .update({ name, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('id,name,operator_id,created_at,updated_at')
      .single();
    if (error) throw error;
    return res.json({ success: true, folder: data });
  } catch (err: any) {
    return res.status(400).json({ success: false, error: err.message ?? 'Failed to rename folder' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('lead_folders')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ success: false, error: err.message ?? 'Failed to delete folder' });
  }
});

router.post('/:id/members', async (req, res) => {
  try {
    const leadIds = Array.isArray(req.body?.lead_ids) ? req.body.lead_ids.filter(Boolean) : [];
    if (leadIds.length === 0) {
      return res.status(400).json({ success: false, error: 'lead_ids array is required' });
    }

    const { error } = await supabase
      .from('leads')
      .update({ folder_id: req.params.id })
      .in('id', leadIds);
    if (error) throw error;

    const { count, error: countError } = await supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('folder_id', req.params.id)
      .in('id', leadIds);
    if (countError) throw countError;

    return res.json({ success: true, inserted: count ?? 0 });
  } catch (err: any) {
    return res.status(400).json({ success: false, error: err.message ?? 'Failed to add members' });
  }
});

router.delete('/:id/members/:leadId', async (req, res) => {
  try {
    const { error } = await supabase
      .from('leads')
      .update({ folder_id: null })
      .eq('id', req.params.leadId)
      .eq('folder_id', req.params.id);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ success: false, error: err.message ?? 'Failed to remove member' });
  }
});

router.get('/:id/members', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('leads')
      .select('id')
      .eq('folder_id', req.params.id);
    if (error) throw error;
    return res.json({
      success: true,
      lead_ids: (data ?? []).map((d: any) => d.id),
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message ?? 'Failed to list members' });
  }
});

export default router;
