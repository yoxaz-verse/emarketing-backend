import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PasswordResetEmailServiceError,
  requestPasswordResetWithDeps,
} from './passwordReset.service.js';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const validResetEnv = {
  PASSWORD_RESET_SMTP_PROVIDER: 'smtp',
  PASSWORD_RESET_SMTP_HOST: 'smtp.example.com',
  PASSWORD_RESET_SMTP_PORT: '465',
  PASSWORD_RESET_SMTP_USERNAME: 'security@example.com',
  PASSWORD_RESET_SMTP_PASSWORD: 'secret',
  PASSWORD_RESET_SMTP_ENCRYPTION: 'ssl',
};

class FakeDb {
  tokenDeletes = 0;
  tokenInserts: any[] = [];

  constructor(private user: any = { id: 'user-1' }) {}

  from(table: string) {
    if (table === 'users') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: this.user }),
          }),
        }),
      };
    }

    if (table === 'password_reset_tokens') {
      return {
        delete: () => ({
          eq: async () => {
            this.tokenDeletes += 1;
            return { error: null };
          },
        }),
        insert: async (row: any) => {
          this.tokenInserts.push(row);
          return { error: null };
        },
      };
    }

    throw new Error(`Unexpected table ${table}`);
  }
}

function baseDeps(overrides: {
  db?: FakeDb;
  env?: NodeJS.ProcessEnv;
  sendMail?: (mail: any, servername?: string) => Promise<void>;
  attempts?: string[];
} = {}) {
  const attempts = overrides.attempts ?? [];
  return {
    db: overrides.db ?? new FakeDb(),
    env: overrides.env ?? validResetEnv,
    hashPasswordFn: async (value: string) => `hashed:${value}`,
    generateOtpFn: () => '123456',
    createTransportFn: (_smtp: any, servername?: string) => {
      attempts.push(String(servername ?? ''));
      return {
        sendMail: async (mail: any) => {
          await (overrides.sendMail ?? (async () => undefined))(mail, servername);
        },
      } as any;
    },
    logger: {
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
    },
  };
}

test('unknown email returns generic success without attempting SMTP', async () => {
  const db = new FakeDb(null);
  const attempts: string[] = [];

  const result = await requestPasswordResetWithDeps('missing@example.com', baseDeps({ db, env: {}, attempts }));

  assert.deepEqual(result, { success: true, message: 'Verification code sent if account exists.' });
  assert.equal(attempts.length, 0);
  assert.equal(db.tokenInserts.length, 0);
});

test('missing reset SMTP config returns a service error for an existing user', async () => {
  const db = new FakeDb();

  await assert.rejects(
    () => requestPasswordResetWithDeps('user@example.com', baseDeps({ db, env: {} })),
    PasswordResetEmailServiceError
  );

  assert.equal(db.tokenInserts.length, 0);
});

test('SMTP send failure returns a service error and does not insert a reset token', async () => {
  const db = new FakeDb();

  await assert.rejects(
    () =>
      requestPasswordResetWithDeps(
        'user@example.com',
        baseDeps({
          db,
          sendMail: async () => {
            throw new Error('SMTP rejected message');
          },
        })
      ),
    PasswordResetEmailServiceError
  );

  assert.equal(db.tokenInserts.length, 0);
});

test('successful SMTP send inserts one reset token and returns success', async () => {
  const db = new FakeDb();
  let deliveredTo = '';

  const result = await requestPasswordResetWithDeps(
    'USER@example.com',
    baseDeps({
      db,
      sendMail: async (mail) => {
        deliveredTo = mail.to;
      },
    })
  );

  assert.deepEqual(result, { success: true, message: 'Verification code sent if account exists.' });
  assert.equal(deliveredTo, 'user@example.com');
  assert.equal(db.tokenDeletes, 1);
  assert.equal(db.tokenInserts.length, 1);
  assert.equal(db.tokenInserts[0].email, 'user@example.com');
  assert.equal(db.tokenInserts[0].otp_hash, 'hashed:123456');
});

test('MXroute TLS hostname mismatch tries alternate SNI candidates', async () => {
  const db = new FakeDb();
  const attempts: string[] = [];

  await requestPasswordResetWithDeps(
    'user@example.com',
    baseDeps({
      db,
      attempts,
      env: {
        ...validResetEnv,
        PASSWORD_RESET_SMTP_PROVIDER: 'mxroute',
        PASSWORD_RESET_SMTP_HOST: 'mail.customer-domain.com',
      },
      sendMail: async (_mail, servername) => {
        if (servername === 'mail.customer-domain.com') {
          const err: any = new Error("Hostname/IP does not match certificate's altnames");
          err.code = 'ERR_TLS_CERT_ALTNAME_INVALID';
          throw err;
        }
      },
    })
  );

  assert.deepEqual(attempts, ['mail.customer-domain.com', 'shared.mxroute.com']);
  assert.equal(db.tokenInserts.length, 1);
});
