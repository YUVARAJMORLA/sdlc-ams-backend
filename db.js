/**
 * backend/db.js  -- PostgreSQL / Supabase edition
 * Fully aligned with TCS MaturityIQ Blueprint v2.0
 * Supports 7 tables, audit logging, auto-updating triggers, and seamless migrations.
 */

import 'dotenv/config';
import pkg from 'pg';
import crypto from 'crypto';
const { Pool } = pkg;

function cleanValue(val) {
  if (val === undefined || val === null) return '';
  const str = String(val).trim();
  return str.replace(/^["']|["']$/g, '').trim();
}

let host = cleanValue(process.env.DB_HOST);
let port = cleanValue(process.env.DB_PORT);
let database = cleanValue(process.env.DB_NAME);
let user = cleanValue(process.env.DB_USER);
let password = cleanValue(process.env.DB_PASSWORD);

// If DATABASE_URL is provided, safely parse with URL class
if (process.env.DATABASE_URL) {
  try {
    const rawUrl = cleanValue(process.env.DATABASE_URL);
    const parsed = new URL(rawUrl);
    if (!host) host = parsed.hostname;
    if (!port) port = parsed.port;
    if (!database && parsed.pathname) database = parsed.pathname.replace(/^\//, '');
    if (!user && parsed.username) user = decodeURIComponent(parsed.username);
    if (!password && parsed.password) password = decodeURIComponent(parsed.password);
  } catch (err) {
    console.warn('[db] Failed to parse DATABASE_URL:', err.message);
  }
}

// Project defaults
host = host || 'aws-0-ap-northeast-2.pooler.supabase.com';
port = parseInt(port || '5432', 10);
database = database || 'postgres';
user = user || 'postgres.xzhtcetjqqvrqauoelcz';
password = password || 'YUVARAJMORLA';

// ─────────────────────────────────────────────────────────
// Connection Pool
// ─────────────────────────────────────────────────────────
const pool = new Pool({
  host,
  port,
  database,
  user,
  password,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err.message);
});

// Diagnostic connection test helper
export async function testDbConnection() {
  const maskedPass = password ? `${password[0]}***${password.slice(-1)} (length: ${password.length})` : 'MISSING';
  const config = {
    host,
    port,
    database,
    user,
    passwordPreview: maskedPass,
    ssl: true,
  };

  async function tryConnect(p) {
    const testPool = new Pool({
      host,
      port: p,
      database,
      user,
      password,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000,
    });
    try {
      const client = await testPool.connect();
      try {
        const res = await client.query('SELECT NOW() as now, current_user as "currentUser", current_database() as "currentDb"');
        return { success: true, port: p, result: res.rows[0] };
      } finally {
        client.release();
      }
    } catch (err) {
      return {
        success: false,
        port: p,
        error: {
          message: err.message,
          code: err.code,
        },
      };
    } finally {
      await testPool.end().catch(() => {});
    }
  }

  // Test configured port
  const primaryResult = await tryConnect(port);
  if (primaryResult.success) {
    return { success: true, config, result: primaryResult.result };
  }

  // Alternate port (5432 <-> 6543)
  const alternatePort = port === 5432 ? 6543 : 5432;
  const altResult = await tryConnect(alternatePort);

  return {
    success: false,
    config,
    primaryPort: { port, ...primaryResult },
    alternatePort: { port: alternatePort, ...altResult },
    error: primaryResult.error,
  };
}

// Generic query helper
export async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    client.release();
  }
}

// Schema bootstrap & migrations according to TCS MaturityIQ Blueprint
async function initSchema() {
  const client = await pool.connect();
  try {
    // 1. Timestamp trigger function
    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // 2. Table: users
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id             VARCHAR(50)  PRIMARY KEY,
        email          VARCHAR(255) UNIQUE NOT NULL,
        password_hash  VARCHAR(255) NOT NULL,
        password       VARCHAR(255),
        role           VARCHAR(20)  DEFAULT 'user' CHECK (role IN ('user','admin','viewer')),
        full_name      VARCHAR(255),
        name           VARCHAR(255),
        employee_id    VARCHAR(50),
        business_group VARCHAR(255),
        account        VARCHAR(255),
        is_active      BOOLEAN      DEFAULT true,
        last_login_at  TIMESTAMP,
        created_at     TIMESTAMP    DEFAULT NOW(),
        updated_at     TIMESTAMP    DEFAULT NOW()
      );
    `);

    // Migrate any missing columns on users
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_id VARCHAR(50);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS business_group VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS account VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
    `);

    // 3. Table: questions
    await client.query(`
      CREATE TABLE IF NOT EXISTS questions (
        id            SERIAL       PRIMARY KEY,
        framework     VARCHAR(10)  NOT NULL DEFAULT 'SDLC' CHECK (framework IN ('SDLC','AMS')),
        area          VARCHAR(100) NOT NULL,
        sub_area      VARCHAR(300) NOT NULL,
        practice      VARCHAR(400) NOT NULL,
        question_type VARCHAR(50)  DEFAULT 'extent',
        type          VARCHAR(50)  DEFAULT 'extent',
        question_text TEXT         NOT NULL,
        weightage     NUMERIC(4,2) DEFAULT 1.00,
        is_active     BOOLEAN      DEFAULT true,
        sort_order    INT          DEFAULT 0,
        created_at    TIMESTAMP    DEFAULT NOW(),
        updated_at    TIMESTAMP    DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_questions_framework ON questions(framework);
      CREATE INDEX IF NOT EXISTS idx_questions_area ON questions(area);
    `);

    // Add unique constraint on practice if not present
    try {
      await client.query(`
        ALTER TABLE questions ADD CONSTRAINT uq_questions_practice UNIQUE (framework, area, sub_area, practice);
      `);
    } catch (_) {}

    // 4. Table: assessments
    await client.query(`
      CREATE TABLE IF NOT EXISTS assessments (
        id               VARCHAR(50)  PRIMARY KEY,
        user_id          VARCHAR(50)  NOT NULL,
        user_email       VARCHAR(255),
        project_name     VARCHAR(255) NOT NULL,
        framework        VARCHAR(10)  DEFAULT 'SDLC' CHECK (framework IN ('SDLC','AMS')),
        status           VARCHAR(20)  DEFAULT 'completed' CHECK (status IN ('draft','in_progress','completed','archived')),
        answers          JSONB        DEFAULT '{}',
        scores           JSONB        DEFAULT '{}',
        overall_score    NUMERIC(5,2) DEFAULT 0.00,
        answer_count     INT          DEFAULT 0,
        remarks          TEXT,
        remarks_provider VARCHAR(50),
        feedback         JSONB,
        created_at       TIMESTAMP    DEFAULT NOW(),
        updated_at       TIMESTAMP    DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_assessments_user_id ON assessments(user_id);
      CREATE INDEX IF NOT EXISTS idx_assessments_framework ON assessments(framework);
      CREATE INDEX IF NOT EXISTS idx_assessments_created_at ON assessments(created_at DESC);
    `);

    // Migrate assessments columns
    await client.query(`
      ALTER TABLE assessments ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'completed';
      ALTER TABLE assessments ADD COLUMN IF NOT EXISTS answer_count INT DEFAULT 0;
      ALTER TABLE assessments ALTER COLUMN overall_score TYPE NUMERIC(5,2);
    `);

    // 5. Table: assessment_reports
    await client.query(`
      CREATE TABLE IF NOT EXISTS assessment_reports (
        id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        assessment_id       VARCHAR(50)  NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
        provider            VARCHAR(50),
        model               VARCHAR(100),
        prompt_version      VARCHAR(20)  DEFAULT 'v1.0',
        report_json         JSONB,
        generation_status   VARCHAR(20)  DEFAULT 'pending' CHECK (generation_status IN ('pending','generating','completed','failed','fallback')),
        error_message       TEXT,
        generation_time_ms  INT,
        retry_count         SMALLINT     DEFAULT 0,
        created_at          TIMESTAMP    DEFAULT NOW(),
        updated_at          TIMESTAMP    DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_reports_assessment_id ON assessment_reports(assessment_id);
    `);

    // 6. Table: feedback
    await client.query(`
      CREATE TABLE IF NOT EXISTS feedback (
        id             VARCHAR(50)  PRIMARY KEY,
        assessment_id  VARCHAR(50)  NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
        user_id        VARCHAR(50)  NOT NULL,
        user_email     VARCHAR(255),
        rating         SMALLINT     NOT NULL CHECK (rating >= 1 AND rating <= 5),
        comments       TEXT,
        created_at     TIMESTAMP    DEFAULT NOW(),
        updated_at     TIMESTAMP    DEFAULT NOW()
      );
    `);

    try {
      await client.query(`
        ALTER TABLE feedback ADD CONSTRAINT uq_feedback_user_assessment UNIQUE (assessment_id, user_id);
      `);
    } catch (_) {}

    // 7. Table: settings
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id                  SMALLINT     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        active_ai_provider  VARCHAR(50)  DEFAULT 'gemini' CHECK (active_ai_provider IN ('openai','gemini','claude','ollama','expert')),
        api_keys            JSONB        DEFAULT '{"openai":"","gemini":"","claude":""}',
        api_endpoints       JSONB        DEFAULT '{"openai":"","gemini":"","claude":"","ollama":""}',
        ollama_url          VARCHAR(255) DEFAULT 'http://localhost:11434',
        ollama_model        VARCHAR(100) DEFAULT 'llama3',
        updated_at          TIMESTAMP    DEFAULT NOW()
      );
    `);

    // 8. Table: audit_log
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id       VARCHAR(50),
        action        VARCHAR(100) NOT NULL,
        entity_type   VARCHAR(50),
        entity_id     VARCHAR(100),
        old_values    JSONB,
        new_values    JSONB,
        ip_address    TEXT,
        user_agent    TEXT,
        created_at    TIMESTAMP    DEFAULT NOW()
      );
    `);

    // Attach triggers
    const triggerTables = ['users', 'questions', 'assessments', 'assessment_reports', 'feedback', 'settings'];
    for (const t of triggerTables) {
      try {
        await client.query(`
          DROP TRIGGER IF EXISTS trigger_update_updated_at_${t} ON ${t};
          CREATE TRIGGER trigger_update_updated_at_${t}
          BEFORE UPDATE ON ${t}
          FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        `);
      } catch (_) {}
    }

    // Seed default admin user (password: admin123)
    await client.query(`
      INSERT INTO users (id, email, password_hash, password, role, full_name, name, is_active)
      VALUES (
        'admin_user',
        'admin@sdlc.com',
        '$2a$10$e3lC5nLrQEWCmu15W69ux./xMB45aDURPA3skiFXmcmmySIWCAD.G',
        '$2a$10$e3lC5nLrQEWCmu15W69ux./xMB45aDURPA3skiFXmcmmySIWCAD.G',
        'admin',
        'System Administrator',
        'System Administrator',
        true
      )
      ON CONFLICT (id) DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        password = EXCLUDED.password,
        role = 'admin';
    `);

    // Seed default settings
    await client.query(`
      INSERT INTO settings (id, active_ai_provider, api_keys, ollama_url, ollama_model, api_endpoints)
      VALUES (
        1,
        'gemini',
        '{"openai":"","gemini":"","claude":""}',
        'http://localhost:11434',
        'llama3',
        '{"openai":"","gemini":"","claude":"","ollama":""}'
      )
      ON CONFLICT (id) DO NOTHING;
    `);

    console.log('[db] PostgreSQL (Supabase) schema initialised and verified');
  } catch (err) {
    console.warn('[db] Schema bootstrap warning:', err.message);
  } finally {
    client.release();
  }
}

initSchema().catch((err) => {
  console.warn('[db] initSchema warning:', err.message);
});

// ─────────────────────────────────────────────────────────
// AUDIT LOG HELPER
// ─────────────────────────────────────────────────────────
export async function logAudit({ userId, action, entityType = null, entityId = null, oldValues = null, newValues = null, req = null }) {
  try {
    let ipAddress = null;
    let userAgent = null;
    if (req) {
      ipAddress = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress;
      userAgent = req.headers['user-agent'] || null;
    }
    await query(`
      INSERT INTO audit_log (user_id, action, entity_type, entity_id, old_values, new_values, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      userId || null,
      action,
      entityType,
      entityId ? String(entityId) : null,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      ipAddress ? String(ipAddress).slice(0, 200) : null,
      userAgent ? String(userAgent).slice(0, 500) : null,
    ]);
  } catch (err) {
    console.warn('[audit_log] Failed to write audit log:', err.message);
  }
}

// ─────────────────────────────────────────────────────────
// USER METHODS
// ─────────────────────────────────────────────────────────
export async function getUsers() {
  const rows = await query(`
    SELECT id, email, role, full_name, name, employee_id, business_group, account, is_active, last_login_at, created_at, updated_at
    FROM users
    ORDER BY created_at DESC
  `);
  return rows.map(r => ({
    id: r.id,
    email: r.email,
    role: r.role,
    fullName: r.full_name || r.name || '',
    name: r.name || r.full_name || '',
    employeeId: r.employee_id || '',
    businessGroup: r.business_group || '',
    account: r.account || '',
    isActive: r.is_active !== false,
    lastLoginAt: r.last_login_at,
    createdAt: r.created_at,
  }));
}

export async function createUser(email, password, extra = {}, req = null) {
  const bcrypt = await import('bcryptjs');
  const cleanEmail = email.toLowerCase().trim();
  const existing = await query('SELECT id FROM users WHERE LOWER(email) = $1', [cleanEmail]);
  if (existing.length > 0) throw new Error('User already exists');

  const salt = await bcrypt.default.genSalt(10);
  const hashedPassword = await bcrypt.default.hash(password, salt);
  const id = 'user_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);

  const fullName = (extra.fullName || extra.name || '').trim();
  const name = fullName;
  const employeeId = (extra.employeeId || '').trim();
  const businessGroup = (extra.businessGroup || '').trim();
  const account = (extra.account || '').trim();

  await query(`
    INSERT INTO users (
      id, email, password_hash, password, role,
      full_name, name, employee_id, business_group, account, is_active
    ) VALUES ($1, $2, $3, $4, 'user', $5, $6, $7, $8, $9, true)
  `, [
    id, cleanEmail, hashedPassword, hashedPassword,
    fullName, name, employeeId, businessGroup, account
  ]);

  await logAudit({
    userId: id,
    action: 'SIGNUP',
    entityType: 'user',
    entityId: id,
    newValues: { email: cleanEmail, fullName, employeeId, businessGroup, account },
    req,
  });

  return {
    id,
    email: cleanEmail,
    role: 'user',
    fullName,
    name,
    employeeId,
    businessGroup,
    account,
  };
}

export async function authenticateUser(email, password, req = null) {
  const bcrypt = await import('bcryptjs');
  const cleanEmail = email.toLowerCase().trim();
  const rows = await query('SELECT * FROM users WHERE LOWER(email) = $1', [cleanEmail]);
  if (rows.length === 0) return null;
  const user = rows[0];

  const hashToCompare = user.password_hash || user.password;
  if (!hashToCompare) return null;

  const valid = await bcrypt.default.compare(password, hashToCompare);
  if (!valid) return null;

  // Auto-stamp last_login_at
  await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

  await logAudit({
    userId: user.id,
    action: 'LOGIN',
    entityType: 'user',
    entityId: user.id,
    req,
  });

  return {
    id: user.id,
    email: user.email,
    role: user.role || 'user',
    fullName: user.full_name || user.name || '',
    name: user.name || user.full_name || '',
    employeeId: user.employee_id || '',
    businessGroup: user.business_group || '',
    account: user.account || '',
    lastLoginAt: new Date().toISOString(),
  };
}

export async function getUserById(id) {
  const rows = await query(`
    SELECT id, email, role, full_name, name, employee_id, business_group, account, is_active, last_login_at, created_at
    FROM users WHERE id = $1
  `, [id]);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    email: r.email,
    role: r.role,
    fullName: r.full_name || r.name || '',
    name: r.name || r.full_name || '',
    employeeId: r.employee_id || '',
    businessGroup: r.business_group || '',
    account: r.account || '',
    isActive: r.is_active !== false,
    lastLoginAt: r.last_login_at,
    createdAt: r.created_at,
  };
}

export async function ensureAdminUser(passwordHash) {
  const rows = await query("SELECT * FROM users WHERE email = 'admin@sdlc.com'");
  if (rows.length === 0) {
    await query(`
      INSERT INTO users (id, email, password_hash, password, role, full_name, name, is_active)
      VALUES ($1, 'admin@sdlc.com', $2, $2, 'admin', 'System Administrator', 'System Administrator', true)
    `, ['admin_user', passwordHash]);
    return {
      id: 'admin_user',
      email: 'admin@sdlc.com',
      role: 'admin',
      fullName: 'System Administrator',
      name: 'System Administrator',
    };
  }
  const row = rows[0];
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    fullName: row.full_name || row.name || 'System Administrator',
    name: row.name || row.full_name || 'System Administrator',
  };
}

export async function updateUserProfile(userId, updates = {}, req = null) {
  const current = await getUserById(userId);
  if (!current) throw new Error('User not found');

  const fullName = updates.fullName !== undefined ? updates.fullName.trim() : (updates.name !== undefined ? updates.name.trim() : current.fullName);
  const name = fullName;
  const employeeId = updates.employeeId !== undefined ? updates.employeeId.trim() : current.employeeId;
  const businessGroup = updates.businessGroup !== undefined ? updates.businessGroup.trim() : current.businessGroup;
  const account = updates.account !== undefined ? updates.account.trim() : current.account;

  await query(`
    UPDATE users
    SET full_name = $1, name = $2, employee_id = $3, business_group = $4, account = $5, updated_at = NOW()
    WHERE id = $6
  `, [fullName, name, employeeId, businessGroup, account, userId]);

  await logAudit({
    userId,
    action: 'UPDATE_PROFILE',
    entityType: 'user',
    entityId: userId,
    oldValues: current,
    newValues: { fullName, employeeId, businessGroup, account },
    req,
  });

  return getUserById(userId);
}

// ─────────────────────────────────────────────────────────
// ASSESSMENT METHODS
// ─────────────────────────────────────────────────────────
export async function getAssessments(userId = null) {
  const rows = userId
    ? await query('SELECT * FROM assessments WHERE user_id = $1 ORDER BY created_at DESC', [userId])
    : await query('SELECT * FROM assessments ORDER BY created_at DESC');
  return rows.map(parseAssessmentRow);
}

export async function getAssessmentById(id) {
  const rows = await query('SELECT * FROM assessments WHERE id = $1', [id]);
  if (rows.length === 0) return null;
  return parseAssessmentRow(rows[0]);
}

export async function saveAssessment(assessmentData, req = null) {
  const id = assessmentData.id || 'asm_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const existing = await query('SELECT * FROM assessments WHERE id = $1', [id]);

  const answersObj = assessmentData.answers || {};
  const scoresObj  = assessmentData.scores  || {};
  const answers    = JSON.stringify(answersObj);
  const scores     = JSON.stringify(scoresObj);
  const feedback   = JSON.stringify(assessmentData.feedback || null);

  // Compute answers count and precise overall score (NUMERIC 5,2)
  const answerCount = Object.keys(answersObj).length;
  let overallScore = assessmentData.overallScore !== undefined ? parseFloat(assessmentData.overallScore) : null;
  if (overallScore == null || isNaN(overallScore)) {
    const vals = Object.values(scoresObj).map(Number).filter(v => !isNaN(v));
    const avg  = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    overallScore = parseFloat(((avg / 5) * 100).toFixed(2));
  } else {
    overallScore = parseFloat(overallScore.toFixed(2));
  }

  const framework = (assessmentData.framework || 'SDLC').toUpperCase();
  const status    = assessmentData.status || 'completed';

  if (existing.length > 0) {
    await query(`
      UPDATE assessments
      SET user_id=$1, user_email=$2, project_name=$3, framework=$4, status=$5,
          answers=$6::jsonb, scores=$7::jsonb, overall_score=$8, answer_count=$9,
          remarks=$10, remarks_provider=$11, feedback=$12::jsonb, updated_at=NOW()
      WHERE id=$13
    `, [
      assessmentData.userId || assessmentData.user_id,
      assessmentData.userEmail || assessmentData.user_email || '',
      assessmentData.projectName || assessmentData.project_name || '',
      framework, status,
      answers, scores, overallScore, answerCount,
      assessmentData.remarks || null,
      assessmentData.remarksProvider || assessmentData.remarks_provider || null,
      feedback, id
    ]);
  } else {
    await query(`
      INSERT INTO assessments
        (id, user_id, user_email, project_name, framework, status, answers, scores,
         overall_score, answer_count, remarks, remarks_provider, feedback)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13::jsonb)
    `, [
      id,
      assessmentData.userId || assessmentData.user_id,
      assessmentData.userEmail || assessmentData.user_email || '',
      assessmentData.projectName || assessmentData.project_name || '',
      framework, status, answers, scores, overallScore, answerCount,
      assessmentData.remarks || null,
      assessmentData.remarksProvider || assessmentData.remarks_provider || null,
      feedback
    ]);
  }

  await logAudit({
    userId: assessmentData.userId || assessmentData.user_id,
    action: existing.length > 0 ? 'UPDATE_ASSESSMENT' : 'CREATE_ASSESSMENT',
    entityType: 'assessment',
    entityId: id,
    newValues: { projectName: assessmentData.projectName, framework, overallScore, answerCount },
    req,
  });

  return getAssessmentById(id);
}

function parseAssessmentRow(row) {
  const scores = typeof row.scores === 'string' ? JSON.parse(row.scores || '{}') : (row.scores || {});
  let overallScore = row.overall_score != null ? parseFloat(row.overall_score) : null;
  if (overallScore == null || isNaN(overallScore)) {
    const vals = Object.values(scores).map(Number).filter(v => !isNaN(v));
    const avg  = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    overallScore = parseFloat(((avg / 5) * 100).toFixed(2));
  }
  return {
    id:              row.id,
    userId:          row.user_id,
    userEmail:       row.user_email,
    projectName:     row.project_name,
    framework:       row.framework || 'SDLC',
    status:          row.status || 'completed',
    answers:         typeof row.answers  === 'string' ? JSON.parse(row.answers  || '{}') : (row.answers  || {}),
    scores,
    overallScore,
    answerCount:     row.answer_count || 0,
    remarks:         row.remarks,
    remarksProvider: row.remarks_provider,
    feedback:        typeof row.feedback === 'string' ? JSON.parse(row.feedback || 'null') : (row.feedback || null),
    createdAt:       row.created_at,
    updatedAt:       row.updated_at
  };
}

// ─────────────────────────────────────────────────────────
// FEEDBACK METHODS
// ─────────────────────────────────────────────────────────
export async function getFeedback() {
  return query('SELECT * FROM feedback ORDER BY created_at DESC');
}

export async function saveFeedback(feedbackData, req = null) {
  const id = 'fb_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const rating = parseInt(feedbackData.rating, 10);
  const rows = await query(`
    INSERT INTO feedback (id, assessment_id, user_id, user_email, rating, comments)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (assessment_id, user_id)
    DO UPDATE SET rating = EXCLUDED.rating, comments = EXCLUDED.comments, updated_at = NOW()
    RETURNING *
  `, [
    id, feedbackData.assessmentId, feedbackData.userId, feedbackData.userEmail || '',
    rating, feedbackData.comments || ''
  ]);

  const saved = rows[0];

  await logAudit({
    userId: feedbackData.userId,
    action: 'SUBMIT_FEEDBACK',
    entityType: 'feedback',
    entityId: saved.id,
    newValues: { assessmentId: feedbackData.assessmentId, rating },
    req,
  });

  return {
    id:           saved.id,
    assessmentId: saved.assessment_id,
    userId:       saved.user_id,
    userEmail:    saved.user_email,
    rating:       saved.rating,
    comments:     saved.comments,
    createdAt:    saved.created_at,
    updatedAt:    saved.updated_at,
  };
}

// ─────────────────────────────────────────────────────────
// QUESTION METHODS
// ─────────────────────────────────────────────────────────
export async function getQuestions(framework = null) {
  const rows = framework
    ? await query('SELECT * FROM questions WHERE UPPER(framework) = $1 ORDER BY id ASC', [framework.toUpperCase()])
    : await query('SELECT * FROM questions ORDER BY id ASC');
  return rows.map(row => ({
    id:           row.id,
    framework:    row.framework || 'SDLC',
    area:         row.area,
    subArea:      row.sub_area,
    practice:     row.practice,
    questionType: row.question_type || row.type || 'extent',
    type:         row.type || row.question_type || 'extent',
    questionText: row.question_text,
    weightage:    row.weightage != null ? parseFloat(row.weightage) : 1.0,
    isActive:     row.is_active !== false,
    sortOrder:    row.sort_order || 0,
  }));
}

export async function saveQuestion(questionData, req = null) {
  const framework = (questionData.framework || 'SDLC').toUpperCase();
  const qType = questionData.questionType || questionData.type || 'extent';

  if (questionData.id) {
    const existing = await query('SELECT * FROM questions WHERE id = $1', [questionData.id]);
    if (existing.length > 0) {
      await query(`
        UPDATE questions
        SET framework=$1, area=$2, sub_area=$3, practice=$4, question_type=$5, type=$5,
            question_text=$6, updated_at=NOW()
        WHERE id=$7
      `, [
        framework, questionData.area, questionData.subArea, questionData.practice,
        qType, questionData.questionText, questionData.id
      ]);

      await logAudit({
        userId: req?.user?.id || null,
        action: 'UPDATE_QUESTION',
        entityType: 'question',
        entityId: questionData.id,
        newValues: questionData,
        req,
      });

      return true;
    }
  } else {
    const duplicate = await query(
      'SELECT id FROM questions WHERE framework = $1 AND area = $2 AND sub_area = $3 AND practice = $4',
      [framework, questionData.area, questionData.subArea, questionData.practice]
    );
    if (duplicate.length > 0) {
      const err = new Error('Duplicate entry for unique practice');
      err.code = '23505';
      throw err;
    }
  }

  const ins = await query(`
    INSERT INTO questions (framework, area, sub_area, practice, question_type, type, question_text)
    VALUES ($1, $2, $3, $4, $5, $5, $6)
    RETURNING id
  `, [
    framework, questionData.area, questionData.subArea, questionData.practice,
    qType, questionData.questionText
  ]);

  await logAudit({
    userId: req?.user?.id || null,
    action: 'CREATE_QUESTION',
    entityType: 'question',
    entityId: ins[0]?.id,
    newValues: questionData,
    req,
  });

  return true;
}

export async function deleteQuestion(id, req = null) {
  const rows = await query('DELETE FROM questions WHERE id = $1 RETURNING *', [parseInt(id)]);
  if (rows.length > 0) {
    await logAudit({
      userId: req?.user?.id || null,
      action: 'DELETE_QUESTION',
      entityType: 'question',
      entityId: id,
      oldValues: rows[0],
      req,
    });
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────
// SETTINGS METHODS
// ─────────────────────────────────────────────────────────
export async function getSettings() {
  const rows = await query('SELECT * FROM settings WHERE id = 1');
  const row  = rows[0] || null;

  const apiKeys      = row ? (typeof row.api_keys      === 'string' ? JSON.parse(row.api_keys      || '{}') : (row.api_keys      || {})) : { openai: '', gemini: '', claude: '' };
  const apiEndpoints = row ? (typeof row.api_endpoints === 'string' ? JSON.parse(row.api_endpoints || '{}') : (row.api_endpoints || {})) : { openai: '', gemini: '', claude: '', ollama: '' };

  const activeAIProvider =
    process.env.ACTIVE_AI_PROVIDER ||
    (row ? row.active_ai_provider : null) ||
    'gemini';

  if (process.env.OPENAI_API_KEY) apiKeys.openai = process.env.OPENAI_API_KEY;
  if (process.env.GEMINI_API_KEY) apiKeys.gemini = process.env.GEMINI_API_KEY;
  if (process.env.CLAUDE_API_KEY) apiKeys.claude = process.env.CLAUDE_API_KEY;

  return {
    activeAIProvider,
    apiKeys,
    ollamaUrl:   (row ? row.ollama_url   : null) || process.env.OLLAMA_URL   || 'http://localhost:11434',
    ollamaModel: (row ? row.ollama_model : null) || process.env.OLLAMA_MODEL || 'llama3',
    apiEndpoints,
  };
}

export async function updateSettings(settingsData, req = null) {
  const current = await getSettings();
  const merged  = { ...current, ...settingsData };
  const apiKeys      = JSON.stringify(merged.apiKeys      || { openai: '', gemini: '', claude: '' });
  const apiEndpoints = JSON.stringify(merged.apiEndpoints || { openai: '', gemini: '', claude: '', ollama: '' });

  await query(`
    INSERT INTO settings (id, active_ai_provider, api_keys, ollama_url, ollama_model, api_endpoints, updated_at)
    VALUES (1, $1, $2::jsonb, $3, $4, $5::jsonb, NOW())
    ON CONFLICT (id) DO UPDATE SET
      active_ai_provider = EXCLUDED.active_ai_provider,
      api_keys           = EXCLUDED.api_keys,
      ollama_url         = EXCLUDED.ollama_url,
      ollama_model       = EXCLUDED.ollama_model,
      api_endpoints      = EXCLUDED.api_endpoints,
      updated_at         = NOW()
  `, [
    merged.activeAIProvider || 'gemini',
    apiKeys,
    merged.ollamaUrl  || 'http://localhost:11434',
    merged.ollamaModel || 'llama3',
    apiEndpoints
  ]);

  await logAudit({
    userId: req?.user?.id || null,
    action: 'UPDATE_SETTINGS',
    entityType: 'settings',
    entityId: '1',
    newValues: { activeAIProvider: merged.activeAIProvider },
    req,
  });

  return getSettings();
}

export async function updateAssessmentRemarks(id, remarks, provider) {
  await query(
    'UPDATE assessments SET remarks = $1, remarks_provider = $2, updated_at = NOW() WHERE id = $3',
    [remarks, provider || 'AI', id]
  );
  return getAssessmentById(id);
}

// ─────────────────────────────────────────────────────────
// ASSESSMENT REPORT METHODS
// ─────────────────────────────────────────────────────────
export async function createReport(assessmentId, promptVersion = 'v1.0') {
  const rows = await query(`
    INSERT INTO assessment_reports (assessment_id, generation_status, prompt_version)
    VALUES ($1, 'pending', $2)
    RETURNING *
  `, [assessmentId, promptVersion]);
  return parseReportRow(rows[0]);
}

export async function updateReport(reportId, updates) {
  const allowed = ['generation_status', 'report_json', 'provider', 'model', 'prompt_version', 'error_message', 'generation_time_ms', 'retry_count'];
  const fields  = Object.keys(updates).filter(k => allowed.includes(k));
  if (fields.length === 0) return getReportById(reportId);

  const setClauses = fields.map((f, i) => f + ' = $' + (i + 1)).join(', ');
  const values = fields.map(f => {
    const v = updates[f];
    return (f === 'report_json' && typeof v === 'object' && v !== null) ? JSON.stringify(v) : v;
  });
  values.push(reportId);

  const rows = await query(
    'UPDATE assessment_reports SET ' + setClauses + ', updated_at = NOW() WHERE id = $' + values.length + ' RETURNING *',
    values
  );
  return rows.length > 0 ? parseReportRow(rows[0]) : getReportById(reportId);
}

export async function getLatestReport(assessmentId) {
  const rows = await query(`
    SELECT * FROM assessment_reports
    WHERE assessment_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [assessmentId]);
  if (rows.length === 0) return null;
  return parseReportRow(rows[0]);
}

export async function getReportById(reportId) {
  const rows = await query('SELECT * FROM assessment_reports WHERE id = $1', [reportId]);
  if (rows.length === 0) return null;
  return parseReportRow(rows[0]);
}

function parseReportRow(row) {
  return {
    id:               row.id,
    assessmentId:     row.assessment_id,
    provider:         row.provider,
    model:            row.model,
    promptVersion:    row.prompt_version,
    reportJson:       typeof row.report_json === 'string' ? JSON.parse(row.report_json || 'null') : (row.report_json || null),
    generationStatus: row.generation_status,
    errorMessage:     row.error_message,
    generationTimeMs: row.generation_time_ms,
    retryCount:       row.retry_count,
    createdAt:        row.created_at,
    updatedAt:        row.updated_at,
  };
}
