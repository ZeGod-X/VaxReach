import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';

const name = process.env.INITIAL_ADMIN_NAME?.trim();
const email = process.env.INITIAL_ADMIN_EMAIL?.trim();
const password = process.env.INITIAL_ADMIN_PASSWORD;

try {
  if (!name || !email || !password) {
    throw new Error('Set INITIAL_ADMIN_NAME, INITIAL_ADMIN_EMAIL, and INITIAL_ADMIN_PASSWORD before creating the first administrator.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid administrator email address.');
  if (password.length < 12) throw new Error('The administrator password must contain at least 12 characters.');
  const existing = await pool.query("SELECT 1 FROM users WHERE role='admin' LIMIT 1");
  if (existing.rowCount) throw new Error('An administrator account already exists. Use the administrator screen to add another.');

  const id = `u_${randomUUID()}`;
  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query(`INSERT INTO users(id,name,email,email_normalized,password_hash,role,active)
    VALUES($1,$2,$3,lower($3),$4,'admin',TRUE)`, [id, name, email, passwordHash]);
  console.log(`Created the initial administrator account for ${email}.`);
} finally {
  await pool.end();
}
