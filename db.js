/**
 * backend/db.js  -- PostgreSQL / Supabase edition
 * Uses the `pg` (node-postgres) library with a connection pool.
 *
 * Sanitizes all environment variables (strips accidental surrounding quotes/spaces)
 * and safely supports both individual DB_* parameters and DATABASE_URL.
 */

import 'dotenv/config';
import pkg from 'pg';
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

// If DATABASE_URL is provided, safely parse with URL class (does NOT strip dots in username)
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
host = host || 'aws-1-ap-northeast-1.pooler.supabase.com';
port = parseInt(port || '5432', 10);
database = database || 'postgres';
user = user || 'postgres.uqsodhpbeiirfvlkfohh';
password = password || 'YUVARAJMORLA123';

// ─────────────────────────────────────────────────────────
// Connection Pool — individual params bypass pg URL parser
// ─────────────────────────────────────────────────────────
const pool = new Pool({
  host,
  port,
  database,
  user,
  password,
  ssl: { rejectUnauthorized: false },
  // Serverless-friendly limits — Vercel spins up many short-lived instances
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
});

// Diagnostic connection test helper — tests primary port and tries 6543 if 5432 fails
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

  // If primary port failed, try alternate port (5432 <-> 6543)
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
async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    client.release();
  }
}

// Schema bootstrap
async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          VARCHAR(50) PRIMARY KEY,
        email       VARCHAR(255) UNIQUE NOT NULL,
        password    VARCHAR(255) NOT NULL,
        role        VARCHAR(20)  NOT NULL DEFAULT 'user',
        name        VARCHAR(255) DEFAULT NULL,
        gender      VARCHAR(20)  DEFAULT NULL,
        created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS questions (
        id            SERIAL PRIMARY KEY,
        framework     VARCHAR(10)  NOT NULL DEFAULT 'SDLC',
        area          VARCHAR(100) NOT NULL,
        sub_area      VARCHAR(300) NOT NULL,
        practice      VARCHAR(400) NOT NULL,
        type          VARCHAR(50)  NOT NULL DEFAULT 'extent',
        question_text TEXT         NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_questions_framework ON questions(framework);
      CREATE INDEX IF NOT EXISTS idx_questions_area      ON questions(area);

      CREATE TABLE IF NOT EXISTS assessments (
        id               VARCHAR(50) PRIMARY KEY,
        user_id          VARCHAR(50)  NOT NULL,
        user_email       VARCHAR(255),
        project_name     VARCHAR(255) NOT NULL,
        framework        VARCHAR(10)  NOT NULL DEFAULT 'SDLC',
        answers          JSONB,
        scores           JSONB,
        overall_score    INT          DEFAULT 0,
        remarks          TEXT,
        remarks_provider VARCHAR(50),
        feedback         JSONB,
        created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
        updated_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_assessments_user_id    ON assessments(user_id);
      CREATE INDEX IF NOT EXISTS idx_assessments_framework  ON assessments(framework);
      CREATE INDEX IF NOT EXISTS idx_assessments_created_at ON assessments(created_at DESC);

      CREATE TABLE IF NOT EXISTS feedback (
        id            VARCHAR(50) PRIMARY KEY,
        assessment_id VARCHAR(50)  NOT NULL,
        user_id       VARCHAR(50)  NOT NULL,
        user_email    VARCHAR(255),
        rating        INT          NOT NULL,
        comments      TEXT,
        created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS assessment_reports (
        id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
        assessment_id     VARCHAR(50) NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
        provider          VARCHAR(50),
        model             VARCHAR(100),
        prompt_version    VARCHAR(20) DEFAULT 'v1.0',
        report_json       JSONB,
        generation_status VARCHAR(20) DEFAULT 'pending'
          CHECK (generation_status IN ('pending','generating','completed','failed','fallback')),
        created_at        TIMESTAMP   DEFAULT NOW(),
        updated_at        TIMESTAMP   DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_reports_assessment_id ON assessment_reports(assessment_id);

      CREATE TABLE IF NOT EXISTS settings (
        id                  INT          PRIMARY KEY DEFAULT 1,
        active_ai_provider  VARCHAR(50)  NOT NULL DEFAULT 'ollama',
        api_keys            JSONB,
        ollama_url          VARCHAR(255) DEFAULT 'http://localhost:11434',
        ollama_model        VARCHAR(100) DEFAULT 'llama3',
        api_endpoints       JSONB        DEFAULT NULL
      );
    `);

    await client.query(`
      INSERT INTO users (id, email, password, role)
      VALUES ('admin_user','admin@sdlc.com','$2a$10$e3lC5nLrQEWCmu15W69ux./xMB45aDURPA3skiFXmcmmySIWCAD.G','admin')
      ON CONFLICT (id) DO NOTHING
    `);

    await client.query(`
      INSERT INTO settings (id, active_ai_provider, api_keys, ollama_url, ollama_model, api_endpoints)
      VALUES (1,'ollama','{"openai":"","gemini":"","claude":""}','http://localhost:11434','llama3','{"openai":"","gemini":"","claude":"","ollama":""}')
      ON CONFLICT (id) DO NOTHING
    `);

    console.log('PostgreSQL (Supabase) schema initialised');
  } finally {
    client.release();
  }
}

initSchema().catch((err) => {
  console.error('Failed to initialise schema:', err.message);
});

// USER METHODS
export async function getUsers() {
  return query('SELECT id, email, role, name, gender, created_at FROM users ORDER BY created_at DESC');
}

export async function createUser(email, password) {
  const bcrypt = await import('bcryptjs');
  const existing = await query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
  if (existing.length > 0) throw new Error('User already exists');

  const salt = await bcrypt.default.genSalt(10);
  const hashedPassword = await bcrypt.default.hash(password, salt);
  const id = 'user_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);

  await query(
    'INSERT INTO users (id, email, password, role) VALUES ($1, $2, $3, $4)',
    [id, email.toLowerCase(), hashedPassword, 'user']
  );
  return { id, email: email.toLowerCase() };
}

export async function authenticateUser(email, password) {
  const bcrypt = await import('bcryptjs');
  const rows = await query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
  if (rows.length === 0) return null;
  const user = rows[0];

  const valid = await bcrypt.default.compare(password, user.password);
  if (!valid) return null;

  return { id: user.id, email: user.email, role: user.role, name: user.name || '', gender: user.gender || '' };
}

export async function getUserById(id) {
  const rows = await query(
    'SELECT id, email, role, name, gender, created_at FROM users WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}

export async function ensureAdminUser(passwordHash) {
  const rows = await query("SELECT * FROM users WHERE email = 'admin@sdlc.com'");
  if (rows.length === 0) {
    await query(
      'INSERT INTO users (id, email, password, role) VALUES ($1, $2, $3, $4)',
      ['admin_user', 'admin@sdlc.com', passwordHash, 'admin']
    );
    return { id: 'admin_user', email: 'admin@sdlc.com', role: 'admin', name: '', gender: '' };
  }
  const row = rows[0];
  return { id: row.id, email: row.email, role: row.role, name: row.name || '', gender: row.gender || '' };
}

export async function updateUserProfile(userId, name, gender) {
  await query('UPDATE users SET name = $1, gender = $2 WHERE id = $3', [name, gender, userId]);
  return getUserById(userId);
}

// ASSESSMENT METHODS
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

export async function saveAssessment(assessmentData) {
  const id = assessmentData.id || 'asm_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const existing = await query('SELECT id FROM assessments WHERE id = $1', [id]);

  const answers      = JSON.stringify(assessmentData.answers  || {});
  const scores       = JSON.stringify(assessmentData.scores   || {});
  const feedback     = JSON.stringify(assessmentData.feedback || null);
  const overallScore = parseInt(assessmentData.overallScore   || 0);
  const framework    = assessmentData.framework || 'SDLC';

  if (existing.length > 0) {
    await query(`
      UPDATE assessments
      SET user_id=$1, user_email=$2, project_name=$3, framework=$4, answers=$5::jsonb,
          scores=$6::jsonb, overall_score=$7, remarks=$8, remarks_provider=$9,
          feedback=$10::jsonb, updated_at=NOW()
      WHERE id=$11
    `, [
      assessmentData.userId || assessmentData.user_id,
      assessmentData.userEmail || assessmentData.user_email || '',
      assessmentData.projectName || assessmentData.project_name || '',
      framework, answers, scores, overallScore,
      assessmentData.remarks || null,
      assessmentData.remarksProvider || assessmentData.remarks_provider || null,
      feedback, id
    ]);
  } else {
    await query(`
      INSERT INTO assessments
        (id, user_id, user_email, project_name, framework, answers, scores, overall_score,
         remarks, remarks_provider, feedback)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11::jsonb)
    `, [
      id,
      assessmentData.userId || assessmentData.user_id,
      assessmentData.userEmail || assessmentData.user_email || '',
      assessmentData.projectName || assessmentData.project_name || '',
      framework, answers, scores, overallScore,
      assessmentData.remarks || null,
      assessmentData.remarksProvider || assessmentData.remarks_provider || null,
      feedback
    ]);
  }
  return getAssessmentById(id);
}

function parseAssessmentRow(row) {
  const scores = typeof row.scores === 'string' ? JSON.parse(row.scores || '{}') : (row.scores || {});
  let overallScore = row.overall_score != null ? parseInt(row.overall_score) : null;
  if (overallScore == null) {
    const vals = Object.values(scores);
    const avg  = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    overallScore = Math.round((avg / 5) * 100);
  }
  return {
    id:              row.id,
    userId:          row.user_id,
    userEmail:       row.user_email,
    projectName:     row.project_name,
    framework:       row.framework || 'SDLC',
    answers:         typeof row.answers  === 'string' ? JSON.parse(row.answers  || '{}') : (row.answers  || {}),
    scores,
    overallScore,
    remarks:         row.remarks,
    remarksProvider: row.remarks_provider,
    feedback:        typeof row.feedback === 'string' ? JSON.parse(row.feedback || 'null') : (row.feedback || null),
    createdAt:       row.created_at,
    updatedAt:       row.updated_at
  };
}

// FEEDBACK METHODS
export async function getFeedback() {
  return query('SELECT * FROM feedback ORDER BY created_at DESC');
}

export async function saveFeedback(feedbackData) {
  const id = 'fb_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  await query(
    'INSERT INTO feedback (id, assessment_id, user_id, user_email, rating, comments) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, feedbackData.assessmentId, feedbackData.userId, feedbackData.userEmail || '',
     feedbackData.rating, feedbackData.comments || '']
  );
  return {
    id,
    assessmentId: feedbackData.assessmentId,
    userId:       feedbackData.userId,
    userEmail:    feedbackData.userEmail,
    rating:       feedbackData.rating,
    comments:     feedbackData.comments,
    createdAt:    new Date().toISOString()
  };
}

// QUESTION METHODS
export async function getQuestions(framework = null) {
  const rows = framework
    ? await query('SELECT * FROM questions WHERE framework = $1 ORDER BY id ASC', [framework.toUpperCase()])
    : await query('SELECT * FROM questions ORDER BY id ASC');
  return rows.map(row => ({
    id:           row.id,
    framework:    row.framework || 'SDLC',
    area:         row.area,
    subArea:      row.sub_area,
    practice:     row.practice,
    type:         row.type,
    questionText: row.question_text
  }));
}

export async function saveQuestion(questionData) {
  if (questionData.id) {
    const existing = await query('SELECT id FROM questions WHERE id = $1', [questionData.id]);
    if (existing.length > 0) {
      await query(
        'UPDATE questions SET area=$1, sub_area=$2, practice=$3, type=$4, question_text=$5 WHERE id=$6',
        [questionData.area, questionData.subArea, questionData.practice,
         questionData.type || 'extent', questionData.questionText, questionData.id]
      );
      return true;
    }
  } else {
    const duplicate = await query(
      'SELECT id FROM questions WHERE area = $1 AND sub_area = $2 AND practice = $3',
      [questionData.area, questionData.subArea, questionData.practice]
    );
    if (duplicate.length > 0) {
      const err = new Error('Duplicate entry for unique practice');
      err.code = '23505';
      throw err;
    }
  }
  await query(
    'INSERT INTO questions (area, sub_area, practice, type, question_text) VALUES ($1,$2,$3,$4,$5)',
    [questionData.area, questionData.subArea, questionData.practice,
     questionData.type || 'extent', questionData.questionText]
  );
  return true;
}

export async function deleteQuestion(id) {
  const rows = await query('DELETE FROM questions WHERE id = $1 RETURNING id', [parseInt(id)]);
  return rows.length > 0;
}

// SETTINGS METHODS
export async function getSettings() {
  const rows = await query('SELECT * FROM settings WHERE id = 1');
  const row  = rows[0] || null;

  const apiKeys      = row ? (typeof row.api_keys      === 'string' ? JSON.parse(row.api_keys      || '{}') : (row.api_keys      || {})) : { openai: '', gemini: '', claude: '' };
  const apiEndpoints = row ? (typeof row.api_endpoints === 'string' ? JSON.parse(row.api_endpoints || '{}') : (row.api_endpoints || {})) : { openai: '', gemini: '', claude: '', ollama: '' };

  const activeAIProvider =
    process.env.ACTIVE_AI_PROVIDER ||
    (row ? row.active_ai_provider : null) ||
    'expert';

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

export async function updateSettings(settingsData) {
  const current = await getSettings();
  const merged  = { ...current, ...settingsData };
  const apiKeys      = JSON.stringify(merged.apiKeys      || { openai: '', gemini: '', claude: '' });
  const apiEndpoints = JSON.stringify(merged.apiEndpoints || { openai: '', gemini: '', claude: '', ollama: '' });

  await query(`
    INSERT INTO settings (id, active_ai_provider, api_keys, ollama_url, ollama_model, api_endpoints)
    VALUES (1, $1, $2::jsonb, $3, $4, $5::jsonb)
    ON CONFLICT (id) DO UPDATE SET
      active_ai_provider = EXCLUDED.active_ai_provider,
      api_keys           = EXCLUDED.api_keys,
      ollama_url         = EXCLUDED.ollama_url,
      ollama_model       = EXCLUDED.ollama_model,
      api_endpoints      = EXCLUDED.api_endpoints
  `, [
    merged.activeAIProvider || 'ollama',
    apiKeys,
    merged.ollamaUrl  || 'http://localhost:11434',
    merged.ollamaModel || 'llama3',
    apiEndpoints
  ]);
  return getSettings();
}

export async function updateAssessmentRemarks(id, remarks, provider) {
  await query(
    'UPDATE assessments SET remarks = $1, remarks_provider = $2 WHERE id = $3',
    [remarks, provider || 'AI', id]
  );
  return getAssessmentById(id);
}

// ASSESSMENT REPORT METHODS
export async function createReport(assessmentId, promptVersion = 'v1.0') {
  const rows = await query(`
    INSERT INTO assessment_reports (assessment_id, generation_status, prompt_version)
    VALUES ($1, 'pending', $2)
    RETURNING *
  `, [assessmentId, promptVersion]);
  return parseReportRow(rows[0]);
}

export async function updateReport(reportId, updates) {
  const allowed = ['generation_status', 'report_json', 'provider', 'model', 'prompt_version'];
  const fields  = Object.keys(updates).filter(k => allowed.includes(k));
  if (fields.length === 0) return getReportById(reportId);

  const setClauses = fields.map((f, i) => f + ' = $' + (i + 1)).join(', ');
  const values = fields.map(f => {
    const v = updates[f];
    return (f === 'report_json' && typeof v === 'object') ? JSON.stringify(v) : v;
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
    createdAt:        row.created_at,
    updatedAt:        row.updated_at,
  };
}
