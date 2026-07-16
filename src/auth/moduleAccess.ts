import type { Request, Response, NextFunction } from 'express';

export const MODULE_ACCESS_KEYS = [
  'marketing',
  'newsletter',
  'social_media',
  'openflow_ai',
  'inquiry',
  'industry_intelligence',
] as const;

export type ModuleAccessKey = typeof MODULE_ACCESS_KEYS[number];
export type ModuleAccessFlags = Record<ModuleAccessKey, boolean>;

const MODULE_ACCESS_SET = new Set<string>(MODULE_ACCESS_KEYS);

function parseRawAccessFlags(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parseRawAccessFlags(parsed);
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return null;
}

function parseAccessBoolean(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
  }
  return false;
}

export function isAdminRole(role?: string | null): boolean {
  const normalized = String(role ?? '').toLowerCase();
  return normalized === 'admin' || normalized === 'superadmin';
}

export function emptyModuleAccess(): ModuleAccessFlags {
  return MODULE_ACCESS_KEYS.reduce((acc, key) => {
    acc[key] = false;
    return acc;
  }, {} as ModuleAccessFlags);
}

export function fullModuleAccess(): ModuleAccessFlags {
  return MODULE_ACCESS_KEYS.reduce((acc, key) => {
    acc[key] = true;
    return acc;
  }, {} as ModuleAccessFlags);
}

export function normalizeModuleAccessFlags(
  raw: unknown,
  role?: string | null
): ModuleAccessFlags {
  if (isAdminRole(role)) {
    return fullModuleAccess();
  }

  const parsed = parseRawAccessFlags(raw);
  const normalized = emptyModuleAccess();
  if (!parsed) {
    return normalized;
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (MODULE_ACCESS_SET.has(key)) {
      normalized[key as ModuleAccessKey] = parseAccessBoolean(value);
    }
  }

  return normalized;
}

export function hasModuleAccess(
  role: string | null | undefined,
  accessFlags: unknown,
  module: ModuleAccessKey
): boolean {
  if (isAdminRole(role)) return true;
  return normalizeModuleAccessFlags(accessFlags, role)[module] === true;
}

export function requireModuleAccess(module: ModuleAccessKey) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (hasModuleAccess(req.auth?.role, req.auth?.access_flags, module)) {
      return next();
    }

    return res.status(403).json({
      error: 'Module access required',
      module,
    });
  };
}
