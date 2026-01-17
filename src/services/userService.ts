import { supabase } from '../supabase.js';
import { hashPassword } from '../utils/password.js';

export type CreateUserInput = {
  email: string;
  password: string;
  role: 'superadmin' | 'admin' | 'operator' | 'viewer';
  operator_id?: string;
};

export async function createUser(input: CreateUserInput) {
  const password_hash = await hashPassword(input.password);

  const { error } = await supabase.from('users').insert({
    email: input.email,
    password_hash,
    role: input.role,
    operator_id: input.operator_id ?? null,
    active: true
  });

  if (error) {
    throw new Error(error.message);
  }
}
