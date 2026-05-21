// src/routes/crud.ts
import { Router } from 'express';
import { ALLOWED_TABLES } from '../config/allowedTables';
import { deleteRow, deleteRowsBulk, insertRow, listRows, updateRow } from '../services/crudService';
import { requireAuth } from '../middleware/requireAuth';

const router = Router();

router.use(requireAuth('viewer'));

const ADMIN_ONLY_TABLES = new Set<string>([
  'users',
  'api_keys',
  'system_events',
  'password_reset_tokens',
]);

function validateTable(table: string) {
  if (!ALLOWED_TABLES.includes(table as any)) {
    throw new Error('Table not allowed');
  }
  return table as any;
}

function assertTablePermission(req: any, table: string) {
  const role = String(req?.auth?.role ?? '');
  const isAdmin = role === 'admin' || role === 'superadmin';
  if (ADMIN_ONLY_TABLES.has(table) && !isAdmin) {
    throw new Error('Insufficient permissions');
  }
}

function resolveStatusCode(err: any, fallback: number) {
  const statusCode = Number(err?.statusCode ?? err?.status ?? 0);
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600) {
    return statusCode;
  }
  return fallback;
}

router.get('/:table', async (req, res) => {
  try {
    console.log("CRUD CALLED of", req.params.table);
    console.log("Query is ", req.query);

    const table = validateTable(req.params.table);
    assertTablePermission(req, table);
    const rows = await listRows(table, req.query, req.auth);

    if (table === 'sequences') {
      console.info('[CRUD_ROUTE_SEQUENCES_RESPONSE]', {
        query: req.query,
        rowCount: Array.isArray(rows) ? rows.length : 0,
      });
    }

    res.json(rows);
  } catch (err: any) {
    console.error('[CRUD LIST ERROR]', err);
    res.status(resolveStatusCode(err, 500)).json({
      error: err.message ?? 'Failed to fetch rows',
    });
  }
});

router.post('/:table', async (req, res) => {
  try {
    const table = validateTable(req.params.table);
    assertTablePermission(req, table);
    await insertRow(table, req.body, req.auth);
    res.json({ success: true });
  } catch (err: any) {
    console.error('[CRUD INSERT ERROR]', err);
    res.status(resolveStatusCode(err, 400)).json({ error: err.message });
  }
});

router.put('/:table/:id', async (req, res) => {
  try {
    const table = validateTable(req.params.table);
    assertTablePermission(req, table);

    console.log('[CRUD UPDATE]', table, req.params.id, req.body);

    await updateRow(table, req.params.id, req.body, req.auth);

    res.json({ success: true });
  } catch (err: any) {
    console.error('[CRUD UPDATE ERROR]', err);
    res.status(resolveStatusCode(err, 400)).json({
      error: err.message ?? 'Update failed',
    });
  }
});

router.post('/:table/bulk-delete', async (req, res) => {
  try {
    const table = validateTable(req.params.table);
    assertTablePermission(req, table);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const result = await deleteRowsBulk(table, ids, req.auth);
    res.json({
      success: true,
      deletedCount: result.deletedCount,
      requestedCount: result.requestedCount,
      filteredCount: result.filteredCount,
    });
  } catch (err: any) {
    console.error('[CRUD BULK DELETE ERROR]', err);
    res.status(resolveStatusCode(err, 400)).json({
      error: err.message ?? 'Bulk delete failed',
    });
  }
});

router.delete('/:table/:id', async (req, res) => {
  try {
    const table = validateTable(req.params.table);
    assertTablePermission(req, table);

    await deleteRow(table, req.params.id, req.auth);

    res.json({ success: true });
  } catch (err: any) {
    console.error('[CRUD DELETE ERROR]', err);
    res.status(resolveStatusCode(err, 400)).json({
      error: err.message ?? 'Delete failed',
    });
  }
});


export default router;
