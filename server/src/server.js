import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { pool } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../');
const app = express();
const production = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET || '';

if (sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must contain at least 32 characters.');
}

app.disable('x-powered-by');
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://*.tile.openstreetmap.org'],
      connectSrc: ["'self'", 'https://*.tile.openstreetmap.org'],
      fontSrc: ["'self'", 'data:', 'https://unpkg.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '8kb' }));
app.use(express.static(resolve(root, 'public'), { index: false, maxAge: production ? '1h' : 0 }));

const PgSessionStore = connectPgSimple(session);
app.use(session({
  name: 'vaxreach.sid',
  store: new PgSessionStore({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true' || production,
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000,
    path: '/'
  }
}));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many sign-in attempts. Try again later.' } });
app.use('/api/', apiLimiter);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function assertSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    try {
      const expected = `${req.protocol}://${req.get('host')}`;
      if (new URL(origin).origin !== expected) return res.status(403).json({ error: 'Cross-origin request rejected.' });
    } catch {
      return res.status(403).json({ error: 'Invalid request origin.' });
    }
  }
  next();
}

function requireCsrf(req, res, next) {
  if (!req.session?.csrfToken || !req.get('x-csrf-token')) return res.status(403).json({ error: 'Refresh your session before continuing.' });
  const expected = Buffer.from(req.session.csrfToken);
  const provided = Buffer.from(req.get('x-csrf-token'));
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return res.status(403).json({ error: 'Invalid request token.' });
  next();
}

function safeUser(row) {
  return { id: row.id, name: row.name, email: row.email, role: row.role, phone: row.phone || '', facility: row.facility || '', active: row.active };
}

async function requireAuth(req, res, next) {
  try {
    if (!req.session?.userId) return res.status(401).json({ error: 'Sign in is required.' });
    const result = await pool.query(
      'SELECT id, name, email, role, phone, facility, active FROM users WHERE id = $1',
      [req.session.userId]
    );
    const user = result.rows[0];
    if (!user?.active) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'This account is not active.' });
    }
    req.user = safeUser(user);
    next();
  } catch (error) {
    next(error);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have permission for this action.' });
    next();
  };
}

function csrfToken() { return randomBytes(32).toString('base64url'); }

const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200)
});
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, 'Enter a valid calendar date.');

const draftSchema = z.object({
  clientDraftId: z.string().trim().min(8).max(100),
  scheduleId: z.string().trim().min(1).max(100),
  administeredDate: isoDateSchema,
  notes: z.string().trim().max(500).optional().default('')
});

const createUserSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(200),
  role: z.enum(['admin', 'worker', 'child']),
  phone: z.string().trim().max(40).optional().default(''),
  facility: z.string().trim().max(160).optional().default(''),
  childId: z.string().trim().max(100).optional().nullable()
}).superRefine((value, context) => {
  if (value.role !== 'child' && value.childId) context.addIssue({ code: 'custom', path: ['childId'], message: 'Only a child account can be linked to a child record.' });
  if (value.role === 'child' && !value.childId) context.addIssue({ code: 'custom', path: ['childId'], message: 'Select the child record for this family account.' });
});

const createChildSchema = z.object({
  name: z.string().trim().min(2).max(120),
  dob: isoDateSchema,
  sex: z.string().trim().max(30).optional().default(''),
  householdId: z.string().trim().max(100).optional().default(''),
  guardianName: z.string().trim().max(120).optional().default(''),
  phone: z.string().trim().max(40).optional().default(''),
  community: z.string().trim().max(120).optional().default(''),
  district: z.string().trim().max(120).optional().default(''),
  address: z.string().trim().max(240).optional().default(''),
  assignedWorkerId: z.string().trim().min(1).max(100)
}).superRefine((value, context) => {
  if (!value.householdId) {
    if (value.guardianName.length < 2) context.addIssue({ code: 'custom', path: ['guardianName'], message: 'Enter a household contact name.' });
    if (value.phone.length < 5) context.addIssue({ code: 'custom', path: ['phone'], message: 'Enter a household contact phone number.' });
    if (value.community.length < 2) context.addIssue({ code: 'custom', path: ['community'], message: 'Enter a community.' });
    if (value.district.length < 2) context.addIssue({ code: 'custom', path: ['district'], message: 'Enter a district.' });
  }
});

const createSchedulesSchema = z.object({
  schedules: z.array(z.object({
    vaccineCode: z.string().trim().min(1).max(40),
    dueDate: isoDateSchema
  })).min(1).max(60)
}).superRefine((value, context) => {
  const seen = new Set();
  value.schedules.forEach((schedule, index) => {
    const code = schedule.vaccineCode.toLowerCase();
    if (seen.has(code)) context.addIssue({ code: 'custom', path: ['schedules', index, 'vaccineCode'], message: 'A vaccine can appear only once per child schedule.' });
    seen.add(code);
  });
});

const activeSchema = z.object({ active: z.boolean() });
const accountProfileSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(40).optional(),
  facility: z.string().trim().max(160).optional(),
  guardianName: z.string().trim().max(120).optional()
}).superRefine((value, context) => {
  if (![value.name, value.phone, value.facility, value.guardianName].some(item => item !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Enter at least one profile detail to save.' });
  }
});

const reviewSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(500).optional().default('')
}).superRefine((value, context) => {
  if (value.decision === 'rejected' && !value.note) {
    context.addIssue({ code: 'custom', path: ['note'], message: 'A reason is required when requesting changes.' });
  }
});

app.get('/api/v1/health', async (_req, res, next) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) { next(error); }
});

app.get('/api/v1/config', (_req, res) => {
  res.json({ demoMode: process.env.DEMO_MODE === 'true' });
});

app.post('/api/v1/auth/login', assertSameOrigin, loginLimiter, async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Enter a valid email and password.' });
    const result = await pool.query(
      'SELECT id, name, email, role, phone, facility, active, password_hash FROM users WHERE email_normalized = lower($1)',
      [parsed.data.email]
    );
    const user = result.rows[0];
    const valid = user && user.active && await bcrypt.compare(parsed.data.password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Email or password is incorrect.' });

    await new Promise((resolvePromise, rejectPromise) => req.session.regenerate(error => error ? rejectPromise(error) : resolvePromise()));
    req.session.userId = user.id;
    req.session.csrfToken = csrfToken();
    await new Promise((resolvePromise, rejectPromise) => req.session.save(error => error ? rejectPromise(error) : resolvePromise()));
    res.json({ user: safeUser(user), csrfToken: req.session.csrfToken });
  } catch (error) { next(error); }
});

app.get('/api/v1/auth/me', requireAuth, (req, res) => {
  if (!req.session.csrfToken) req.session.csrfToken = csrfToken();
  res.json({ user: req.user, csrfToken: req.session.csrfToken });
});

app.post('/api/v1/auth/logout', assertSameOrigin, requireCsrf, requireAuth, async (req, res, next) => {
  try {
    await new Promise((resolvePromise, rejectPromise) => req.session.destroy(error => error ? rejectPromise(error) : resolvePromise()));
    res.clearCookie('vaxreach.sid', { httpOnly: true, secure: process.env.COOKIE_SECURE === 'true' || production, sameSite: 'lax', path: '/' });
    res.status(204).end();
  } catch (error) { next(error); }
});

app.patch('/api/v1/account', assertSameOrigin, requireCsrf, requireAuth, async (req, res, next) => {
  try {
    const parsed = accountProfileSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Profile details are invalid.' });
    const input = parsed.data;
    if (req.user.role === 'child' && (input.name !== undefined || input.facility !== undefined)) {
      return res.status(400).json({ error: 'A child name or health record must be changed by an administrator.' });
    }
    if (req.user.role !== 'child' && input.guardianName !== undefined) {
      return res.status(400).json({ error: 'Guardian details can only be changed from a linked child account.' });
    }
    const user = await withTransaction(async client => {
      let updated;
      if (req.user.role === 'child') {
        await client.query('UPDATE users SET phone=COALESCE($1,phone) WHERE id=$2', [input.phone ?? null, req.user.id]);
        const child = await client.query(`UPDATE children SET phone=COALESCE($1,phone),guardian_name=COALESCE($2,guardian_name)
          WHERE account_id=$3 RETURNING household_id`, [input.phone ?? null, input.guardianName ?? null, req.user.id]);
        if (child.rows[0]?.household_id) {
          await client.query(`UPDATE households SET phone=COALESCE($1,phone),head=COALESCE($2,head) WHERE id=$3`,
          [input.phone ?? null, input.guardianName ?? null, child.rows[0].household_id]);
        }
        updated = await client.query('SELECT id,name,email,role,phone,facility,active FROM users WHERE id=$1', [req.user.id]);
      } else {
        updated = await client.query(`UPDATE users SET name=COALESCE($1,name),phone=COALESCE($2,phone),facility=COALESCE($3,facility)
          WHERE id=$4 RETURNING id,name,email,role,phone,facility,active`,
        [input.name ?? null, input.phone ?? null, input.facility ?? null, req.user.id]);
      }
      await client.query(`INSERT INTO audit_log(actor_id,actor_name,action,target_type,target_id,details)
        VALUES($1,$2,'Updated profile','user',$1,$3::jsonb)`,
      [req.user.id, req.user.name, JSON.stringify({ fields: Object.keys(input) })]);
      return updated.rows[0];
    });
    res.json({ user: safeUser(user) });
  } catch (error) { next(error); }
});

app.get('/api/v1/bootstrap', requireAuth, async (req, res, next) => {
  try {
    const childParams = [];
    let childFilter = '';
    if (req.user.role === 'worker') { childParams.push(req.user.id); childFilter = 'WHERE c.assigned_worker_id = $1'; }
    else if (req.user.role === 'child') { childParams.push(req.user.id); childFilter = 'WHERE c.account_id = $1'; }
    const children = await pool.query(`
      SELECT c.id, c.unique_id AS "uniqueId", c.name, c.dob::text AS dob, c.sex,
             c.account_id AS "accountId", c.household_id AS "householdId",
             c.assigned_worker_id AS "assignedWorkerId", c.guardian_name AS "guardianName",
             c.phone, c.community, c.district, c.created_at AS "createdAt"
      FROM children c ${childFilter} ORDER BY c.name`, childParams);
    const childIds = children.rows.map(child => child.id);
    const users = req.user.role === 'admin'
      ? await pool.query('SELECT id,name,email,role,phone,facility,active,created_at AS "createdAt" FROM users ORDER BY name')
      : await pool.query('SELECT id,name,email,role,phone,facility,active,created_at AS "createdAt" FROM users WHERE id=$1', [req.user.id]);
    const householdIds = [...new Set(children.rows.map(child => child.householdId).filter(Boolean))];
    const households = householdIds.length
      ? await pool.query(`SELECT id,head,phone,community,district,address,lat,lng FROM households WHERE id=ANY($1::text[])`, [householdIds])
      : { rows: [] };
    let schedules = [];
    if (req.user.role === 'admin') {
      const result = await pool.query(`SELECT id, child_id AS "childId", vaccine_code AS "vaccineCode", due_date::text AS "dueDate", administered_date::text AS "administeredDate", status, source, notes, administered_by AS "administeredBy", verified_by AS "verifiedBy", verified_at AS "verifiedAt" FROM vaccination_schedules ORDER BY due_date`);
      schedules = result.rows;
    } else if (childIds.length) {
      const result = await pool.query(`SELECT id, child_id AS "childId", vaccine_code AS "vaccineCode", due_date::text AS "dueDate", administered_date::text AS "administeredDate", status, source, notes, administered_by AS "administeredBy", verified_by AS "verifiedBy", verified_at AS "verifiedAt" FROM vaccination_schedules WHERE child_id = ANY($1::text[]) ORDER BY due_date`, [childIds]);
      schedules = result.rows;
    }
    res.json({ user: req.user, users: users.rows, children: children.rows, households: households.rows, schedules });
  } catch (error) { next(error); }
});

app.post('/api/v1/admin/users', assertSameOrigin, requireCsrf, requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Account details are invalid.' });
    const { name, email, password, role, phone, facility, childId } = parsed.data;
    const id = `u_${randomUUID()}`;
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await withTransaction(async client => {
      if (childId) {
        const child = await client.query('SELECT id,account_id FROM children WHERE id=$1 FOR UPDATE', [childId]);
        if (!child.rowCount) throw httpError(404, 'Child record not found.');
        if (child.rows[0].account_id) throw httpError(409, 'This child already has a linked account.');
      }
      const result = await client.query(`INSERT INTO users(id,name,email,email_normalized,password_hash,role,phone,facility)
        VALUES($1,$2,$3,lower($3),$4,$5,$6,$7)
        RETURNING id,name,email,role,phone,facility,active,created_at AS "createdAt"`,
      [id, name, email, passwordHash, role, phone, facility]);
      if (childId) await client.query('UPDATE children SET account_id=$1 WHERE id=$2', [id, childId]);
      await client.query(`INSERT INTO audit_log(actor_id,actor_name,action,target_type,target_id,details)
        VALUES($1,$2,'Created user account','user',$3,$4::jsonb)`,
      [req.user.id, req.user.name, id, JSON.stringify({ role, email: result.rows[0].email, childId: childId || null })]);
      return result.rows[0];
    });
    res.status(201).json({ user });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'An account with that email already exists.' });
    next(error);
  }
});

app.patch('/api/v1/admin/users/:id', assertSameOrigin, requireCsrf, requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const parsed = activeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Choose whether this account should be active.' });
    if (req.params.id === req.user.id && !parsed.data.active) return res.status(409).json({ error: 'You cannot disable your own administrator account.' });
    const user = await withTransaction(async client => {
      const result = await client.query(`UPDATE users SET active=$1 WHERE id=$2
        RETURNING id,name,email,role,phone,facility,active`, [parsed.data.active, req.params.id]);
      if (!result.rowCount) throw httpError(404, 'Account not found.');
      await client.query(`INSERT INTO audit_log(actor_id,actor_name,action,target_type,target_id,details)
        VALUES($1,$2,$3,'user',$4,$5::jsonb)`,
      [req.user.id, req.user.name, parsed.data.active ? 'Enabled user account' : 'Disabled user account', req.params.id, JSON.stringify({ active: parsed.data.active })]);
      return result.rows[0];
    });
    res.json({ user });
  } catch (error) { next(error); }
});

async function draftRows(where, parameters) {
  const result = await pool.query(`
    SELECT d.id, d.client_draft_id AS "clientDraftId", d.worker_id AS "workerId",
           w.name AS "workerName", d.schedule_id AS "scheduleId", d.child_id AS "childId",
           c.name AS "childName", d.vaccine_code AS "vaccineCode",
           d.administered_date::text AS "administeredDate", d.notes, d.status,
           d.review_note AS "reviewNote", d.reviewed_by AS "reviewedBy",
           reviewer.name AS "reviewerName", d.reviewed_at AS "reviewedAt",
           d.created_at AS "createdAt", d.updated_at AS "updatedAt", d.synced_at AS "syncedAt"
    FROM vaccination_drafts d
    JOIN users w ON w.id = d.worker_id
    JOIN children c ON c.id = d.child_id
    LEFT JOIN users reviewer ON reviewer.id = d.reviewed_by
    ${where}
    ORDER BY CASE WHEN d.status = 'pending_review' THEN 0 ELSE 1 END, d.updated_at DESC`, parameters);
  return result.rows;
}

app.get('/api/v1/vaccination-drafts', requireAuth, async (req, res, next) => {
  try {
    const drafts = req.user.role === 'admin'
      ? await draftRows("WHERE d.status = 'pending_review' OR d.status IN ('approved','rejected')", [])
      : req.user.role === 'worker'
        ? await draftRows('WHERE d.worker_id = $1', [req.user.id])
        : [];
    res.json({ drafts });
  } catch (error) { next(error); }
});

async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

app.post('/api/v1/admin/children', assertSameOrigin, requireCsrf, requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const parsed = createChildSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Child details are invalid.' });
    const input = parsed.data;
    const result = await withTransaction(async client => {
      const worker = await client.query("SELECT id FROM users WHERE id=$1 AND role='worker' AND active=TRUE", [input.assignedWorkerId]);
      if (!worker.rowCount) throw httpError(422, 'Choose an active health worker.');
      const today = (await client.query("SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS today")).rows[0].today;
      if (input.dob > today) throw httpError(422, 'Date of birth cannot be in the future.');

      let household;
      let householdId = input.householdId;
      if (householdId) {
        household = await client.query(`SELECT id,head,phone,community,district,address,lat,lng FROM households WHERE id=$1`, [householdId]);
        if (!household.rowCount) throw httpError(404, 'Household record not found.');
        household = household.rows[0];
      } else {
        householdId = `h_${randomUUID()}`;
        const inserted = await client.query(`INSERT INTO households(id,head,phone,community,district,address)
          VALUES($1,$2,$3,$4,$5,$6)
          RETURNING id,head,phone,community,district,address,lat,lng`,
        [householdId, input.guardianName, input.phone, input.community, input.district, input.address]);
        household = inserted.rows[0];
      }
      const childId = `c_${randomUUID()}`;
      const uniqueId = `VR-${new Date().getFullYear()}-${randomBytes(4).toString('hex').toUpperCase()}`;
      const guardianName = input.householdId ? household.head : input.guardianName;
      const phone = input.householdId ? household.phone : input.phone;
      const community = input.householdId ? household.community : input.community;
      const district = input.householdId ? household.district : input.district;
      const child = await client.query(`INSERT INTO children(id,unique_id,name,dob,sex,household_id,assigned_worker_id,guardian_name,phone,community,district)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING id,unique_id AS "uniqueId",name,dob::text AS dob,sex,account_id AS "accountId",household_id AS "householdId",assigned_worker_id AS "assignedWorkerId",guardian_name AS "guardianName",phone,community,district,created_at AS "createdAt"`,
      [childId, uniqueId, input.name, input.dob, input.sex, householdId, input.assignedWorkerId, guardianName, phone, community, district]);
      await client.query(`INSERT INTO audit_log(actor_id,actor_name,action,target_type,target_id,details)
        VALUES($1,$2,'Created child record','child',$3,$4::jsonb)`,
      [req.user.id, req.user.name, childId, JSON.stringify({ householdId, assignedWorkerId: input.assignedWorkerId })]);
      return { child: child.rows[0], household };
    });
    res.status(201).json(result);
  } catch (error) { next(error); }
});

app.post('/api/v1/admin/children/:id/schedules', assertSameOrigin, requireCsrf, requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const parsed = createSchedulesSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Schedule details are invalid.' });
    const schedules = await withTransaction(async client => {
      const child = await client.query('SELECT id FROM children WHERE id=$1', [req.params.id]);
      if (!child.rowCount) throw httpError(404, 'Child record not found.');
      const created = [];
      for (const item of parsed.data.schedules) {
        const id = `s_${randomUUID()}`;
        const result = await client.query(`INSERT INTO vaccination_schedules(id,child_id,vaccine_code,due_date,status,source)
          VALUES($1,$2,$3,$4,
            CASE WHEN $4::date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date THEN 'upcoming'
                 WHEN $4::date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date THEN 'overdue' ELSE 'due' END,
            'Admin entered — validate against approved schedule')
          RETURNING id,child_id AS "childId",vaccine_code AS "vaccineCode",due_date::text AS "dueDate",administered_date::text AS "administeredDate",status,source`,
        [id, req.params.id, item.vaccineCode, item.dueDate]);
        created.push(result.rows[0]);
      }
      await client.query(`INSERT INTO audit_log(actor_id,actor_name,action,target_type,target_id,details)
        VALUES($1,$2,'Added vaccination schedule','child',$3,$4::jsonb)`,
      [req.user.id, req.user.name, req.params.id, JSON.stringify({ count: created.length })]);
      return created;
    });
    res.status(201).json({ schedules });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A dose with this vaccine code already exists for this child.' });
    next(error);
  }
});

app.post('/api/v1/vaccination-drafts', assertSameOrigin, requireCsrf, requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const parsed = draftSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Check the draft details and try again.' });
    const { clientDraftId, scheduleId, administeredDate, notes } = parsed.data;
    const outcome = await withTransaction(async client => {
      const scheduleResult = await client.query(`
        SELECT s.id, s.child_id, s.vaccine_code, s.administered_date,
               c.assigned_worker_id,
               (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS today
        FROM vaccination_schedules s
        JOIN children c ON c.id = s.child_id
        WHERE s.id = $1
        FOR UPDATE OF s`, [scheduleId]);
      const schedule = scheduleResult.rows[0];
      if (!schedule || schedule.assigned_worker_id !== req.user.id) throw httpError(404, 'This vaccine dose is not assigned to your worklist.');
      if (schedule.administered_date) throw httpError(409, 'This dose already has an approved vaccination record.');
      if (administeredDate > schedule.today) throw httpError(422, 'The vaccination date cannot be in the future.');

      const existingResult = await client.query(
        'SELECT id, status FROM vaccination_drafts WHERE worker_id = $1 AND client_draft_id = $2 FOR UPDATE',
        [req.user.id, clientDraftId]
      );
      const existing = existingResult.rows[0];
      if (existing && existing.status !== 'rejected') return { id: existing.id, reused: true };

      const pending = await client.query(
        "SELECT id FROM vaccination_drafts WHERE schedule_id = $1 AND status = 'pending_review' AND id <> COALESCE($2, '') FOR UPDATE",
        [scheduleId, existing?.id || '']
      );
      if (pending.rowCount) throw httpError(409, 'A draft for this dose is already awaiting administrator review.');

      let draftId;
      if (existing) {
        const updated = await client.query(`
          UPDATE vaccination_drafts
          SET schedule_id=$1, child_id=$2, vaccine_code=$3, administered_date=$4, notes=$5,
              status='pending_review', review_note=NULL, reviewed_by=NULL, reviewed_at=NULL,
              updated_at=NOW(), synced_at=NOW()
          WHERE id=$6 RETURNING id`,
        [schedule.id, schedule.child_id, schedule.vaccine_code, administeredDate, notes, existing.id]);
        draftId = updated.rows[0].id;
      } else {
        draftId = randomUUID();
        await client.query(`
          INSERT INTO vaccination_drafts
            (id, client_draft_id, worker_id, schedule_id, child_id, vaccine_code, administered_date, notes, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_review')`,
        [draftId, clientDraftId, req.user.id, schedule.id, schedule.child_id, schedule.vaccine_code, administeredDate, notes]);
      }
      await client.query(`INSERT INTO audit_log(actor_id,actor_name,action,target_type,target_id,details)
        VALUES($1,$2,'Submitted vaccination draft','vaccination_draft',$3,$4::jsonb)`,
      [req.user.id, req.user.name, draftId, JSON.stringify({ scheduleId, clientDraftId })]);
      return { id: draftId, reused: false };
    });
    const rows = await draftRows('WHERE d.id = $1', [outcome.id]);
    res.status(outcome.reused ? 200 : 201).json({ draft: rows[0], reused: outcome.reused });
  } catch (error) { next(error); }
});

app.post('/api/v1/vaccination-drafts/:id/review', assertSameOrigin, requireCsrf, requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review details are invalid.' });
    const { decision, note } = parsed.data;
    const result = await withTransaction(async client => {
      const lookup = await client.query('SELECT schedule_id FROM vaccination_drafts WHERE id=$1', [req.params.id]);
      if (!lookup.rowCount) throw httpError(404, 'Vaccination draft not found.');
      const scheduleResult = await client.query('SELECT id, administered_date FROM vaccination_schedules WHERE id=$1 FOR UPDATE', [lookup.rows[0].schedule_id]);
      const draftResult = await client.query('SELECT * FROM vaccination_drafts WHERE id=$1 FOR UPDATE', [req.params.id]);
      const schedule = scheduleResult.rows[0];
      const draft = draftResult.rows[0];
      if (!schedule || !draft) throw httpError(404, 'Vaccination draft not found.');
      if (draft.status !== 'pending_review') throw httpError(409, 'This submission has already been reviewed.');

      if (decision === 'approved') {
        if (schedule.administered_date) throw httpError(409, 'The scheduled dose was already updated. Review cannot be applied.');
        await client.query(`UPDATE vaccination_schedules
          SET administered_date=$1,status='completed',notes=$2,administered_by=$3,verified_by=$4,verified_at=NOW(),updated_at=NOW()
          WHERE id=$5`, [draft.administered_date, draft.notes, draft.worker_id, req.user.id, schedule.id]);
      }

      const updated = await client.query(`UPDATE vaccination_drafts
        SET status=$1,review_note=$2,reviewed_by=$3,reviewed_at=NOW(),updated_at=NOW()
        WHERE id=$4 RETURNING id`, [decision, decision === 'rejected' ? note : null, req.user.id, draft.id]);
      await client.query(`INSERT INTO audit_log(actor_id,actor_name,action,target_type,target_id,details)
        VALUES($1,$2,$3,'vaccination_draft',$4,$5::jsonb)`,
      [req.user.id, req.user.name, decision === 'approved' ? 'Verified vaccination draft' : 'Requested vaccination draft changes', draft.id, JSON.stringify({ scheduleId: schedule.id, note: decision === 'rejected' ? note : '' })]);
      return updated.rows[0];
    });
    const drafts = await draftRows('WHERE d.id = $1', [result.id]);
    const schedule = decision === 'approved'
      ? (await pool.query(`SELECT id,child_id AS "childId",vaccine_code AS "vaccineCode",due_date::text AS "dueDate",administered_date::text AS "administeredDate",status,source,notes,administered_by AS "administeredBy",verified_by AS "verifiedBy",verified_at AS "verifiedAt" FROM vaccination_schedules WHERE id=$1`, [drafts[0].scheduleId])).rows[0]
      : null;
    res.json({ draft: drafts[0], schedule });
  } catch (error) { next(error); }
});

app.get('/api/v1/audit', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT id,actor_name AS "actorName",action,target_type AS "targetType",target_id AS "targetId",created_at AS at,details FROM audit_log ORDER BY created_at DESC LIMIT 100`);
    res.json({ events: result.rows });
  } catch (error) { next(error); }
});

app.get('/sw.js', async (_req, res, next) => {
  try { res.set('Cache-Control', 'no-cache'); res.type('application/javascript').send(await readFile(resolve(root, 'sw.js'), 'utf8')); }
  catch (error) { next(error); }
});
app.get('/manifest.webmanifest', async (_req, res, next) => {
  try { res.type('application/manifest+json').send(await readFile(resolve(root, 'manifest.webmanifest'), 'utf8')); }
  catch (error) { next(error); }
});
app.get(['/', '/index.html'], (_req, res) => res.sendFile(resolve(root, 'index.html')));

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use((error, _req, res, _next) => {
  const status = Number(error.status) || 500;
  if (status >= 500) console.error('Request failed:', error.message);
  res.status(status).json({ error: status >= 500 && production ? 'The server could not complete this request.' : error.message });
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const server = app.listen(port, host, () => console.log(`VaxReach listening on http://${host}:${port}`));

async function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
