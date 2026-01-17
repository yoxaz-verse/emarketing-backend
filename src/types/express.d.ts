import { Role } from '../auth/roles';

declare global {
  namespace Express {
    interface Request {
      auth?: {
        type: 'user' | 'api';
        role: Role;
        user_id?: string;
        operator_id?: string | null;
        api_key_id?: string;
      };
    }
  }
}

export {};
