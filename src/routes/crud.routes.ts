// src/routes/crud.ts
import { Router } from 'express';
import { ALLOWED_TABLES } from '../config/allowedTables';
import { deleteRow, insertRow, listRows, updateRow } from '../services/crudService';

const router = Router();

// router.use(requireAuth('operator'));

function validateTable(table: string) {
  if (!ALLOWED_TABLES.includes(table as any)) {
    throw new Error('Table not allowed');
  }
  return table as any;
}

router.get('/:table', async (req, res) => {
  try {
    console.log("CRUD CALLED of", req.params.table);
    console.log("Query is ", req.query);

    const table = validateTable(req.params.table);
    const rows = await listRows(table, req.query);

    res.json(rows);
  } catch (err: any) {
    console.error('[CRUD LIST ERROR]', err);
    res.status(500).json({
      error: err.message ?? 'Failed to fetch rows',
    });
  }
});

router.post('/:table', async (req, res) => {
  try {
    const table = validateTable(req.params.table);
    await insertRow(table, req.body);
    res.json({ success: true });
  } catch (err: any) {
    console.error('[CRUD INSERT ERROR]', err);
    res.status(400).json({ error: err.message });
  }
});

router.put('/:table/:id', async (req, res) => {
  try {
    const table = validateTable(req.params.table);

    console.log('[CRUD UPDATE]', table, req.params.id, req.body);

    await updateRow(table, req.params.id, req.body);

    res.json({ success: true });
  } catch (err: any) {
    console.error('[CRUD UPDATE ERROR]', err);
    res.status(400).json({
      error: err.message ?? 'Update failed',
    });
  }
});

router.delete('/:table/:id', async (req, res) => {
  try {
    const table = validateTable(req.params.table);

    await deleteRow(table, req.params.id);

    res.json({ success: true });
  } catch (err: any) {
    console.error('[CRUD DELETE ERROR]', err);
    res.status(400).json({
      error: err.message ?? 'Delete failed',
    });
  }
});


export default router;
