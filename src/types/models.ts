export interface Inbox {
    id: string;
    email_address: string;
    provider: string;
    daily_limit: number;
    sent_today: number;
    status: 'active' | 'paused';
  }
  
  export interface Lead {
    id: string;
    email: string;
    first_name?: string;
    company?: string;
    status: 'pending' | 'sent' | 'replied' | 'stopped';
  }
  