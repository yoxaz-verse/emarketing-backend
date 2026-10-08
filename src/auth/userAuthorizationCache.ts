import { supabase } from '../supabase.js';
import { Role } from './roles.js';

export type AuthorizedUser = {
  id: string;
  role: Role;
  operator_id: string | null;
  access_flags: Record<string, boolean> | null;
  email: string | null;
  active: boolean;
};

type CacheEntry<T> = { value: T; expiresAt: number };

export function createAuthorizationCache<T>(
  loader: (userId: string) => Promise<T | null>,
  ttlMs = 60_000,
  now: () => number = Date.now,
) {
  const cache = new Map<string, CacheEntry<T>>();
  const pending = new Map<string, Promise<T | null>>();

  async function get(userId: string): Promise<T | null> {
    const cached = cache.get(userId);
    if (cached && cached.expiresAt > now()) return cached.value;
    if (cached) cache.delete(userId);

    const existing = pending.get(userId);
    if (existing) return existing;

    const request = loader(userId)
      .then((value) => {
        if (value !== null) cache.set(userId, { value, expiresAt: now() + ttlMs });
        return value;
      })
      .finally(() => pending.delete(userId));
    pending.set(userId, request);
    return request;
  }

  return {
    get,
    invalidate(userId: string) { cache.delete(userId); },
    clear() { cache.clear(); pending.clear(); },
  };
}

export const userAuthorizationCache = createAuthorizationCache<AuthorizedUser>(async (userId) => {
  const { data, error } = await supabase
    .from('users')
    .select('id,role,operator_id,access_flags,email,active')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  return data as AuthorizedUser | null;
});
