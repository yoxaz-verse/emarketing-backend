export type Database = {
  public: {
    Tables: {
      inboxes: {
        Row: {
          id: string;
          email_address: string;
          provider: string;
          daily_limit: number;
          hourly_limit: number;
          warmup_enabled: boolean;
          warmup_day: number;
          consecutive_failures: number;
          status: string;
          paused_reason: string | null;
          last_sent_at: string | null;
          created_at: string;
        };
        Insert: {
          email_address: string;
          provider: string;
          daily_limit: number;
          hourly_limit: number;
          warmup_enabled?: boolean;
          warmup_day?: number;
          status?: string;
          created_at?: string;
        };
        Update: {
          status?: string;
          paused_reason?: string | null;
          warmup_day?: number;
          consecutive_failures?: number;
          last_sent_at?: string | null;
        };
      };
      

      leads: {
        Row: {
          id: string;
          email: string;
          first_name: string | null;
          company: string | null;
          status: string;
          assigned_inbox_id: string | null;
          created_at: string;
        };
        Insert: {
          email: string;
          first_name?: string | null;
          company?: string | null;
          status?: string;
          assigned_inbox_id?: string | null;
          created_at?: string;
        };
        Update: {
          status?: string;
          assigned_inbox_id?: string | null;
        };
      };

      email_logs: {
        Row: {
          id: string;
          lead_id: string;
          inbox_id: string;
          subject: string;
          body: string;
          status: string;
          sent_at: string;
        };
        Insert: {
          lead_id: string;
          inbox_id: string;
          subject?: string;
          body?: string;
          status: string;
          sent_at?: string;
        };
        Update: {};
      };
    };

    /* 🔑 THESE WERE MISSING — REQUIRED BY SUPABASE */
    Views: {};
    Functions: {};
    Enums: {};
  };
};
