import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import {
  getUsers,
  createUser,
  authenticateUser,
  getUserById,
  ensureAdminUser,
  updateUserProfile,
  getAssessments,
  getAssessmentById,
  saveAssessment,
  getFeedback,
  saveFeedback,
  getQuestions,
  saveQuestion,
  deleteQuestion,
  getSettings,
  updateSettings,
  updateAssessmentRemarks,
  createReport,
  updateReport,
  getLatestReport,
  getReportById,
  testDbConnection,
} from './db.js';
import { getUserIdFromRequest, signToken } from './auth.js';
import {
  getFrameworkConfig,
  VALID_FRAMEWORKS,
  classifyMaturityLevel,
  PROMPT_VERSION,
} from './frameworkConfig.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ── Rate Limiters ────────────────────────────────────────────────────
const aiRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // max 10 AI requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many AI requests. Please wait before trying again.' } },
});

const generalRateLimit = rateLimit({
  windowMs: 60 * 1000,       // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalRateLimit);

// CORS setup — supports localhost (dev) + Vercel frontend URL (prod)
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, mobile apps, server-to-server)
    if (!origin) return callback(null, true);
    // Allow configured origins or any *.vercel.app preview URL
    if (
      ALLOWED_ORIGINS.includes(origin) ||
      /^https:\/\/.*\.vercel\.app$/.test(origin)
    ) {
      return callback(null, true);
    }
    return callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());
app.use(cookieParser());

// Helper middleware to require authentication
async function requireAuth(req, res, next) {
  const user = getUserIdFromRequest(req);
  if (!user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  req.user = user;
  next();
}

// Helper middleware to require admin role
async function requireAdmin(req, res, next) {
  const user = getUserIdFromRequest(req);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ message: 'Unauthorized - Admin only' });
  }
  req.user = user;
  next();
}

// ──────────────────────────────────────────────────────────────────
// SYSTEM & HEALTH ENDPOINTS
// ──────────────────────────────────────────────────────────────────

// GET /api/health — Live database connectivity and environment diagnostics
app.get('/api/health', async (req, res) => {
  try {
    const dbStatus = await testDbConnection();
    return res.status(dbStatus.success ? 200 : 503).json({
      status: dbStatus.success ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      database: dbStatus,
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error.message,
    });
  }
});

// ──────────────────────────────────────────────────────────────────
// AUTH ENDPOINTS
// ──────────────────────────────────────────────────────────────────

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(200).json({ success: false, message: 'Email and password are required' });
    }

    let authenticatedUser = await authenticateUser(email, password);

    // Bootstrap: allow default admin account if it isn't in DB yet
    if (!authenticatedUser && email.toLowerCase() === 'admin@sdlc.com' && password === 'admin123') {
      const bcrypt = await import('bcryptjs');
      const salt = await bcrypt.default.genSalt(10);
      const hashedPassword = await bcrypt.default.hash(password, salt);
      const adminUser = await ensureAdminUser(hashedPassword);

      const token = signToken({ id: adminUser.id, email: 'admin@sdlc.com', role: 'admin' });
      res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/'
      });
      return res.status(200).json({
        token,
        message: 'Admin login successful',
        user: { id: adminUser.id, email: 'admin@sdlc.com', role: 'admin' }
      });
    }

    if (!authenticatedUser) {
      return res.status(200).json({ success: false, message: 'Invalid email or password' });
    }

    const token = signToken(authenticatedUser);
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/'
    });

    return res.status(200).json({
      token,
      message: 'Login successful',
      user: {
        id: authenticatedUser.id,
        email: authenticatedUser.email,
        role: authenticatedUser.role,
        name: authenticatedUser.name || '',
        gender: authenticatedUser.gender || ''
      }
    });
  } catch (error) {
    console.error('Login API Error:', error);
    return res.status(500).json({ message: 'Error authenticating user' });
  }
});

// POST /api/auth/signup
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(200).json({ success: false, message: 'Email and password are required' });
    }

    if (password.length < 6) {
      return res.status(200).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    const newUser = await createUser(email, password);
    const token = signToken(newUser);

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/'
    });

    return res.status(201).json({
      token,
      message: 'User created successfully',
      user: { id: newUser.id, email: newUser.email }
    });
  } catch (error) {
    console.warn('Signup API warning:', error.message || error);
    return res.status(200).json({ success: false, message: error.message || 'Error creating user' });
  }
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token', { path: '/' });
  return res.status(200).json({ message: 'Logged out successfully' });
});

// GET /api/auth/me
app.get('/api/auth/me', async (req, res) => {
  try {
    const userPayload = getUserIdFromRequest(req);

    if (!userPayload) {
      return res.status(200).json({ user: null, message: 'Not authenticated' });
    }

    const dbUser = await getUserById(userPayload.id);
    if (!dbUser) {
      return res.status(200).json({ user: null, message: 'User not found' });
    }

    // Get cookie token or bearer token
    let token = req.cookies.token || null;
    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }
    }

    return res.status(200).json({
      token,
      user: {
        id: dbUser.id,
        email: dbUser.email,
        role: dbUser.role,
        name: dbUser.name || '',
        gender: dbUser.gender || ''
      }
    });
  } catch (error) {
    console.error('Me API Error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────
// USER & PROFILE ENDPOINTS
// ──────────────────────────────────────────────────────────────────

// GET /api/users
app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const users = await getUsers();
    return res.json({ users });
  } catch (error) {
    console.error('Users GET API Error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/users/profile
app.post('/api/users/profile', requireAuth, async (req, res) => {
  try {
    const { name, gender } = req.body;
    const cleanName = (name || '').trim();
    const cleanGender = (gender || '').trim();

    const updatedUser = await updateUserProfile(req.user.id, cleanName, cleanGender);
    return res.json({
      message: 'Profile updated successfully',
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        role: updatedUser.role,
        name: updatedUser.name || '',
        gender: updatedUser.gender || ''
      }
    });
  } catch (error) {
    console.error('Profile Update API Error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────
// SETTINGS ENDPOINTS
// ──────────────────────────────────────────────────────────────────

// GET /api/settings
app.get('/api/settings', requireAdmin, async (req, res) => {
  try {
    const settings = await getSettings();
    
    // Check which keys are present in .env
    settings.envKeys = {
      openai: !!process.env.OPENAI_API_KEY,
      gemini: !!process.env.GEMINI_API_KEY,
      claude: !!process.env.CLAUDE_API_KEY
    };

    return res.json({ settings });
  } catch (error) {
    console.error('Settings GET API Error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/settings
app.post('/api/settings', requireAdmin, async (req, res) => {
  try {
    const settingsData = req.body;
    const { activeAIProvider } = settingsData;

    // Validate that the selected provider's API key is present in environment
    if (activeAIProvider === 'openai') {
      const key = process.env.OPENAI_API_KEY;
      if (!key || !key.trim()) {
        return res.status(400).json({ message: 'OpenAI API key (OPENAI_API_KEY) is not present in the .env file.' });
      }
    } else if (activeAIProvider === 'gemini') {
      const key = process.env.GEMINI_API_KEY;
      if (!key || !key.trim()) {
        return res.status(400).json({ message: 'Google Gemini API key (GEMINI_API_KEY) is not present in the .env file.' });
      }
    } else if (activeAIProvider === 'claude') {
      const key = process.env.CLAUDE_API_KEY;
      if (!key || !key.trim()) {
        return res.status(400).json({ message: 'Anthropic Claude API key (CLAUDE_API_KEY) is not present in the .env file.' });
      }
    }

    const updated = await updateSettings(settingsData);
    return res.json({ message: 'Settings updated successfully', settings: updated });
  } catch (error) {
    console.error('Settings POST API Error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────
// FRAMEWORK ENDPOINTS
// ──────────────────────────────────────────────────────────────────

// GET /api/frameworks
app.get('/api/frameworks', (req, res) => {
  return res.json({ frameworks: VALID_FRAMEWORKS });
});

// ──────────────────────────────────────────────────────────────────
// QUESTIONS ENDPOINTS
// ──────────────────────────────────────────────────────────────────

// GET /api/questions?framework=SDLC
app.get('/api/questions', async (req, res) => {
  try {
    const framework = req.query.framework || null;
    if (framework && !VALID_FRAMEWORKS.includes(framework.toUpperCase())) {
      return res.status(400).json({ message: `Invalid framework. Valid options: ${VALID_FRAMEWORKS.join(', ')}` });
    }
    const questions = await getQuestions(framework);
    return res.json({ questions });
  } catch (error) {
    console.error('Questions GET API Error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/questions
app.post('/api/questions', requireAdmin, async (req, res) => {
  try {
    const questionData = req.body;
    if (!questionData.area || !questionData.subArea || !questionData.practice || !questionData.questionText) {
      return res.status(400).json({ message: 'Missing required question fields' });
    }

    await saveQuestion(questionData);
    return res.json({ message: 'Question saved successfully' });
  } catch (error) {
    // MySQL duplicate entry — UNIQUE constraint on (area, sub_area, practice)
    if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
      return res.status(409).json({
        message: 'A question with this Area, Sub-Area and Practice already exists. Please use a unique combination.'
      });
    }
    console.error('Questions POST API Error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/questions (query param) or DELETE /api/questions/:id (route param)
const deleteQuestionHandler = async (req, res) => {
  try {
    const id = req.params.id || req.query.id;
    if (!id) {
      return res.status(400).json({ message: 'Question ID is required' });
    }

    const deleted = await deleteQuestion(id);
    if (!deleted) {
      return res.status(404).json({ message: 'Question not found' });
    }

    return res.json({ message: 'Question deleted successfully' });
  } catch (error) {
    console.error('Questions DELETE API Error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
};

app.delete('/api/questions/:id', requireAdmin, deleteQuestionHandler);
app.delete('/api/questions', requireAdmin, deleteQuestionHandler);

// ──────────────────────────────────────────────────────────────────
// ASSESSMENT ENDPOINTS
// ──────────────────────────────────────────────────────────────────

// GET /api/assessments
app.get('/api/assessments', requireAuth, async (req, res) => {
  try {
    const userId = req.user.role === 'admin' ? null : req.user.id;
    const assessments = await getAssessments(userId);
    return res.json({ assessments });
  } catch (error) {
    console.error('Assessments GET API Error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/assessments
app.post('/api/assessments', requireAuth, async (req, res) => {
  try {
    const assessmentData = req.body;
    if (!assessmentData.projectName || !assessmentData.answers) {
      return res.status(400).json({ message: 'Missing required assessment fields' });
    }

    // Validate framework
    const framework = (assessmentData.framework || 'SDLC').toUpperCase();
    if (!VALID_FRAMEWORKS.includes(framework)) {
      return res.status(400).json({ message: `Invalid framework. Valid options: ${VALID_FRAMEWORKS.join(', ')}` });
    }

    assessmentData.userId = req.user.id;
    assessmentData.userEmail = req.user.email;
    assessmentData.framework = framework;

    const saved = await saveAssessment(assessmentData);
    return res.json({ message: 'Assessment saved successfully', assessment: saved });
  } catch (error) {
    console.error('Assessments POST API Error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/assessments/:id
app.get('/api/assessments/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const assessment = await getAssessmentById(id);

    if (!assessment) {
      return res.status(404).json({ message: 'Assessment not found' });
    }

    if (req.user.role !== 'admin' && assessment.userId !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized to view this assessment' });
    }

    return res.json({ assessment });
  } catch (error) {
    console.error('Assessments GET ID API Error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// PATCH /api/assessments/:id
app.patch('/api/assessments/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const assessment = await getAssessmentById(id);
    if (!assessment) {
      return res.status(404).json({ message: 'Assessment not found' });
    }
    if (req.user.role !== 'admin' && assessment.userId !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    const { remarks, provider } = req.body;
    const updated = await updateAssessmentRemarks(id, remarks, provider || 'llama3.2');
    return res.json({ assessment: updated });
  } catch (error) {
    console.error('Assessments PATCH Error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/assessments/:id/report
app.get('/api/assessments/:id/report', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const assessment = await getAssessmentById(id);
    if (!assessment) return res.status(404).json({ message: 'Assessment not found' });
    if (req.user.role !== 'admin' && assessment.userId !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized to view this report' });
    }

    const report = await getLatestReport(id);
    if (!report) return res.status(404).json({ message: 'No report found for this assessment' });
    return res.json({ report });
  } catch (error) {
    console.error('Report GET Error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/reports/:id/status
app.get('/api/reports/:id/status', requireAuth, async (req, res) => {
  try {
    const report = await getReportById(req.params.id);
    if (!report) return res.status(404).json({ message: 'Report not found' });

    // Verify access by checking the parent assessment
    const assessment = await getAssessmentById(report.assessmentId);
    if (!assessment) return res.status(404).json({ message: 'Assessment not found' });
    if (req.user.role !== 'admin' && assessment.userId !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    return res.json({ reportId: report.id, status: report.generationStatus, updatedAt: report.updatedAt });
  } catch (error) {
    console.error('Report status Error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────
// FEEDBACK ENDPOINTS
// ──────────────────────────────────────────────────────────────────

// GET /api/feedback
app.get('/api/feedback', requireAdmin, async (req, res) => {
  try {
    const feedback = await getFeedback();
    return res.json({ feedback });
  } catch (error) {
    console.error('Feedback GET API Error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/feedback
app.post('/api/feedback', requireAuth, async (req, res) => {
  try {
    const feedbackData = req.body;
    if (!feedbackData.assessmentId || !feedbackData.rating) {
      return res.status(400).json({ message: 'Missing feedback rating or assessment ID' });
    }

    feedbackData.userId = req.user.id;
    feedbackData.userEmail = req.user.email;

    const saved = await saveFeedback(feedbackData);

    // Also update the assessment record with feedback info
    const assessment = await getAssessmentById(feedbackData.assessmentId);
    if (assessment) {
      assessment.feedback = {
        rating: feedbackData.rating,
        comments: feedbackData.comments || '',
        createdAt: saved.createdAt
      };
      await saveAssessment(assessment);
    }

    return res.json({ message: 'Feedback submitted successfully', feedback: saved });
  } catch (error) {
    console.error('Feedback POST API Error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ──────────────────────────────────────────────────────────────────
// REMARKS ENDPOINTS (AI INSIGHTS GENERATION)
// ──────────────────────────────────────────────────────────────────

// Offline Rule-Based Generator (fallback/offline)
function generateExpertRemarks(scores, answers, questions) {
  const areaMaturities = {};
  for (const area in scores) {
    const score = scores[area];
    let classification = "L0: Traditional";
    if (score >= 4.5) classification = "L5: Agentic Enterprise";
    else if (score >= 3.5) classification = "L4: Autonomous Agent/Workforce";
    else if (score >= 2.5) classification = "L3: Supervised Agent/Factory";
    else if (score >= 1.5) classification = "L2: Delegated/Assistant";
    else if (score >= 0.5) classification = "L1: Assisted/Tool";
    areaMaturities[area] = { score, classification };
  }

  const strengths = {};
  const gaps = {};
  for (const area of ['Requirements', 'Architecture', 'Development', 'Testing', 'Deployment']) {
    strengths[area] = [];
    gaps[area] = [];
  }

  for (const qId in answers) {
    const ans = answers[qId];
    const q = questions.find(question => question.id === parseInt(qId));
    if (q) {
      const level = parseInt(ans.level) || 0;
      if (level >= 3) {
        strengths[q.area].push(q.practice);
      } else if (level <= 1) {
        gaps[q.area].push(q.practice);
      }
    }
  }

  const getFallbackText = (area) => {
    const topStrengths = strengths[area] || [];
    const topGaps = gaps[area] || [];
    const topPractice = topStrengths.length > 0 ? topStrengths[0] : null;
    const mainGap = topGaps.length > 0 ? topGaps[0] : null;

    let processStr = "";
    let toolsStr = "";
    let techniquesStr = "";

    if (area === 'Requirements') {
      processStr = topPractice
        ? `Requirements processes show capability in ${topPractice}. However, ${mainGap || 'backlog grooming'} remains a limitation, requiring structured framework planning to streamline backlog refinement.`
        : `Requirements processes are currently at a baseline level. Introducing structured framework planning is necessary to address standard backlog definition and scope mapping.`;
      toolsStr = `Jira Product Discovery, Gemini 1.5 Pro, Claude 3.5 Sonnet, and Productboard.`;
      techniquesStr = `Leverage Behavior-Driven Development (BDD) generation and automated user story decomposition via LLM agents.`;
    } else if (area === 'Architecture') {
      processStr = topPractice
        ? `Architecture processes demonstrate strength in ${topPractice}. A critical governance gap exists in ${mainGap || 'diagram synchronization'}, which should be targeted to prevent structural divergence.`
        : `Architecture workflows run manually without alignment check gates. Establishing automated model checking will prevent architectural divergence.`;
      toolsStr = `Mermaid.js, Eraser.io, Claude 3.5 Sonnet, and ArchUnit.`;
      techniquesStr = `Establish automated Architecture Decision Record (ADR) creation and code-level architectural drift detection using AST parsing linting rules.`;
    } else if (area === 'Development') {
      processStr = topPractice
        ? `Development practices exhibit competency in ${topPractice}. Addressing ${mainGap || 'inline generation templates'} is necessary to accelerate engineering velocity and guarantee coding standard compliance.`
        : `Development workflows rely on local environments. Incorporating structured developer guidelines and unit test suites will establish codebase quality baselines.`;
      toolsStr = `Cursor IDE, VS Code with GitHub Copilot, and Claude 3.5 Sonnet.`;
      techniquesStr = `Incorporate Model Context Protocol (MCP) servers for codebase searching and orchestrate agent-led refactoring and code reviews.`;
    } else if (area === 'Testing') {
      processStr = topPractice
        ? `Testing procedures show progress in ${topPractice}. However, ${mainGap || 'test case coverage'} presents a major quality bottleneck that increases the risk of regression errors.`
        : `Testing practices are manual and prone to human oversight. Transitioning to automated test suite execution will reduce validation loops and regression errors.`;
      toolsStr = `Playwright, Jest, Cypress, and Mockito.`;
      techniquesStr = `Implement automated agentic test generation, self-healing test suites, and dynamic synthetic mock data synthesis using generative models.`;
    } else if (area === 'Deployment') {
      processStr = topPractice
        ? `Deployment workflows show strength in ${topPractice}. The primary gap identified is ${mainGap || 'canary deployments'}, indicating a need for greater automation in release verification and monitoring.`
        : `Deployment pipelines are manually triggered and lack verification. Automating build and release orchestration will improve delivery security.`;
      toolsStr = `GitHub Actions, ArgoCD, Terraform, and Datadog.`;
      techniquesStr = `Utilize canary deployments with automated rollback verification and integrate AI-driven log analysis for pipeline anomaly discovery.`;
    }

    return `### Process\n${processStr}\n\n### Recommended Tools\n${toolsStr}\n\n### Techniques\n${techniquesStr}`;
  };

  let md = '';
  const areasList = ['Requirements', 'Architecture', 'Development', 'Testing', 'Deployment'];
  areasList.forEach((area, i) => {
    md += `## ${area}\n${getFallbackText(area)}`;
    if (i < areasList.length - 1) {
      md += '\n\n';
    }
  });

  return md;
}

function generateDefaultRemarksOnlyScores(scores) {
  let md = '';
  const areasList = ['Requirements', 'Architecture', 'Development', 'Testing', 'Deployment'];

  const getFallbackText = (area, score) => {
    let classification = "L0: Traditional";
    if (score >= 4.5) classification = "L5: Agentic Enterprise";
    else if (score >= 3.5) classification = "L4: Autonomous Agent/Workforce";
    else if (score >= 2.5) classification = "L3: Supervised Agent/Factory";
    else if (score >= 1.5) classification = "L2: Delegated/Assistant";
    else if (score >= 0.5) classification = "L1: Assisted/Tool";

    let processStr = `${area} capability score is ${score.toFixed(1)}/5, placing the practice in the ${classification} stage. Focus on standardizing capabilities and deploying automated agents to streamline workflows.`;
    let toolsStr = "";
    let techniquesStr = "";

    if (area === 'Requirements') {
      toolsStr = "Jira Product Discovery, Gemini 1.5 Pro, Claude 3.5 Sonnet, and Productboard.";
      techniquesStr = "Leverage Behavior-Driven Development (BDD) generation and automated user story decomposition via LLM agents.";
    } else if (area === 'Architecture') {
      toolsStr = "Mermaid.js, Eraser.io, Claude 3.5 Sonnet, and ArchUnit.";
      techniquesStr = "Establish automated Architecture Decision Record (ADR) creation and code-level architectural drift detection.";
    } else if (area === 'Development') {
      toolsStr = "Cursor IDE, VS Code with GitHub Copilot, and Claude 3.5 Sonnet.";
      techniquesStr = "Incorporate Model Context Protocol (MCP) servers for codebase searching and orchestrate agent-led refactoring.";
    } else if (area === 'Testing') {
      toolsStr = "Playwright, Jest, Cypress, and Mockito.";
      techniquesStr = "Implement automated agentic test generation, self-healing test suites, and dynamic synthetic mock data synthesis.";
    } else if (area === 'Deployment') {
      toolsStr = "GitHub Actions, ArgoCD, Terraform, and Datadog.";
      techniquesStr = "Utilize canary deployments with automated rollback verification and integrate AI-driven log analysis.";
    }

    return `### Process\n${processStr}\n\n### Recommended Tools\n${toolsStr}\n\n### Techniques\n${techniquesStr}`;
  };

  areasList.forEach((area, i) => {
    const score = scores[area] || 0;
    md += `## ${area}\n${getFallbackText(area, score)}`;
    if (i < areasList.length - 1) {
      md += '\n\n';
    }
  });
  return md;
}

// ──────────────────────────────────────────────────────────────────
// REMARKS / REPORT GENERATION  (POST /api/remarks)
// Authenticated, rate-limited, framework-aware, structured JSON output
// ──────────────────────────────────────────────────────────────────

// Validate structured JSON report from AI output
function validateReportJson(obj, areas) {
  if (!obj || typeof obj !== 'object') return false;
  if (typeof obj.executiveSummary !== 'string' || obj.executiveSummary.length < 10) return false;
  if (typeof obj.overallInterpretation !== 'string' || obj.overallInterpretation.length < 10) return false;
  if (!Array.isArray(obj.priorityActions) || obj.priorityActions.length === 0) return false;
  if (!obj.areas || typeof obj.areas !== 'object') return false;
  for (const area of areas) {
    const a = obj.areas[area];
    if (!a) return false;
    if (typeof a.analysis !== 'string') return false;
    if (!Array.isArray(a.strengths)) return false;
    if (!Array.isArray(a.gaps)) return false;
    if (!Array.isArray(a.recommendations)) return false;
    if (!Array.isArray(a.tools)) return false;
    if (!Array.isArray(a.techniques)) return false;
  }
  return true;
}

// Build rule-based fallback in structured JSON format
function buildFallbackReport(framework, scores, strengths, gaps, fwCfg) {
  const areas = {};
  for (const area of fwCfg.areas) {
    const fb = fwCfg.fallback[area] || {};
    const s = strengths[area] || [];
    const g = gaps[area] || [];
    areas[area] = {
      analysis:        typeof fb.process === 'function' ? fb.process(s, g) : `${area} capability requires improvement.`,
      strengths:       s.slice(0, 3),
      gaps:            g.slice(0, 3),
      recommendations: [`Improve ${area.toLowerCase()} AI maturity`, `Address gaps in ${g[0] || 'key practices'}`],
      tools:           fb.tools ? fb.tools.split(', ') : [],
      techniques:      fb.techniques ? [fb.techniques] : [],
    };
  }

  const overallScore = Object.values(scores).reduce((a, b) => a + b, 0) / (fwCfg.areas.length || 1);
  return {
    executiveSummary:      `This ${framework} AI maturity assessment was generated using the expert rule-based engine. Overall maturity level: ${classifyMaturityLevel(overallScore)}.`,
    overallInterpretation: `The organization's ${framework} practices show a maturity level of ${classifyMaturityLevel(overallScore)}. Focus areas include capability improvement across the identified gaps. A systematic approach to AI adoption will accelerate maturity progression.`,
    areas,
    priorityActions: fwCfg.areas
      .filter(a => (gaps[a] || []).length > 0)
      .slice(0, 3)
      .map(a => `Address gaps in ${a}: ${(gaps[a] || []).slice(0, 2).join(', ')}`),
  };
}

// Call AI provider with one unified prompt
async function callAIForReport(prompt, settings) {
  const activeProvider = settings.activeAIProvider || 'expert';

  if (activeProvider === 'ollama') {
    const configuredOllama = settings.apiEndpoints?.ollama || settings.ollamaUrl || 'http://localhost:11434';
    let cleanUrl = configuredOllama.trim().replace(/\/$/, '');
    const targetUrl = cleanUrl.includes('/api/generate') ? cleanUrl : `${cleanUrl}/api/generate`;
    const ollamaModel = settings.ollamaModel || process.env.OLLAMA_MODEL || 'llama3';
    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ollamaModel, prompt, stream: false, options: { temperature: 0.2, num_predict: 2000 } }),
        signal: AbortSignal.timeout(60000)
      });
      if (res.ok) {
        const data = await res.json();
        return { text: data.response?.trim() || null, model: ollamaModel };
      }
    } catch (e) { console.warn('[Report] Ollama call failed:', e.message); }
    return { text: null, model: ollamaModel };
  }

  if (activeProvider === 'openai') {
    const openaiUrl = (settings.apiEndpoints?.openai || 'https://api.openai.com/v1/chat/completions').trim();
    const apiKey = settings.apiKeys?.openai?.trim() || process.env.OPENAI_API_KEY || '';
    const model = 'gpt-4o';
    try {
      const res = await fetch(openaiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 3000, response_format: { type: 'json_object' } }),
        signal: AbortSignal.timeout(60000)
      });
      if (res.ok) {
        const data = await res.json();
        return { text: data.choices?.[0]?.message?.content?.trim() || null, model };
      }
      console.warn('[Report] OpenAI returned status', res.status);
    } catch (e) { console.warn('[Report] OpenAI call failed:', e.message); }
    return { text: null, model };
  }

  if (activeProvider === 'gemini') {
    const geminiModels = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
    const configuredGemini = (settings.apiEndpoints?.gemini || 'https://generativelanguage.googleapis.com').trim().replace(/\/$/, '');
    const apiKey = settings.apiKeys?.gemini?.trim() || process.env.GEMINI_API_KEY || '';
    for (const model of geminiModels) {
      try {
        const targetUrl = `${configuredGemini}/v1/models/${model}:generateContent?key=${apiKey}`;
        const res = await fetch(targetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
          signal: AbortSignal.timeout(60000)
        });
        if (res.ok) {
          const data = await res.json();
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (text) return { text, model };
        }
      } catch (e) { console.warn(`[Report] Gemini (${model}) failed:`, e.message); }
    }
    return { text: null, model: 'gemini' };
  }

  if (activeProvider === 'claude') {
    const claudeUrl = (settings.apiEndpoints?.claude || 'https://api.anthropic.com/v1/messages').trim();
    const apiKey = settings.apiKeys?.claude?.trim() || process.env.CLAUDE_API_KEY || '';
    const model = 'claude-3-5-sonnet-20241022';
    try {
      const res = await fetch(claudeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 3000, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(60000)
      });
      if (res.ok) {
        const data = await res.json();
        return { text: data.content?.[0]?.text?.trim() || null, model };
      }
    } catch (e) { console.warn('[Report] Claude call failed:', e.message); }
    return { text: null, model };
  }

  return { text: null, model: 'none' };
}

// POST /api/remarks — authenticated, rate-limited, framework-aware, structured JSON output
app.post('/api/remarks', requireAuth, aiRateLimit, async (req, res) => {
  const body = req.body || {};
  const scores  = body.scores  || {};
  const answers = body.answers || {};
  const assessmentId = body.assessmentId || null;

  if (!body.scores || !body.answers) {
    return res.status(400).json({ message: 'Missing scores or answers data' });
  }

  // Determine framework from body or assessment
  let framework = (body.framework || 'SDLC').toUpperCase();
  if (!VALID_FRAMEWORKS.includes(framework)) framework = 'SDLC';

  let fwCfg;
  try { fwCfg = getFrameworkConfig(framework); }
  catch (e) { return res.status(400).json({ message: e.message }); }

  // --- Check report cache: return existing completed report if available ---
  if (assessmentId) {
    try {
      const existing = await getLatestReport(assessmentId);
      if (existing && (existing.generationStatus === 'completed' || existing.generationStatus === 'fallback') && existing.reportJson) {
        console.log(`[Report] Returning cached report for assessment ${assessmentId}`);
        return res.json({
          remarks:  existing.reportJson,
          provider: existing.provider || 'cached',
          reportId: existing.id,
          cached:   true,
        });
      }
    } catch (e) { console.warn('[Report] Cache check failed:', e.message); }
  }

  try {
    const [questions, settings] = await Promise.all([getQuestions(framework), getSettings()]);

    // Build strengths/gaps from answers
    const strengths = {};
    const gaps = {};
    for (const area of fwCfg.areas) { strengths[area] = []; gaps[area] = []; }

    questions.forEach(q => {
      const ans = answers[q.id] || answers[String(q.id)];
      if (ans && ans.level !== null && ans.level !== undefined) {
        const lvl = parseInt(ans.level);
        if (!isNaN(lvl)) {
          if (lvl >= 3) strengths[q.area]?.push(q.practice);
          else if (lvl <= 1) gaps[q.area]?.push(q.practice);
        }
      }
    });

    const activeProvider = settings.activeAIProvider || 'expert';

    // --- Expert/rule-based mode ---
    if (activeProvider === 'expert') {
      console.log('[Report] Expert mode selected');
      const fallbackReport = buildFallbackReport(framework, scores, strengths, gaps, fwCfg);

      // Persist to assessment_reports if we have an assessmentId
      let reportId = null;
      if (assessmentId) {
        try {
          const rec = await createReport(assessmentId, PROMPT_VERSION);
          await updateReport(rec.id, { generation_status: 'fallback', report_json: fallbackReport, provider: 'expert', model: 'rule-based' });
          reportId = rec.id;
        } catch (e) { console.warn('[Report] Could not persist expert report:', e.message); }
      }
      return res.json({ remarks: fallbackReport, provider: 'expert', reportId });
    }

    // --- Key presence check ---
    const keyMap = { openai: process.env.OPENAI_API_KEY || settings.apiKeys?.openai, gemini: process.env.GEMINI_API_KEY || settings.apiKeys?.gemini, claude: process.env.CLAUDE_API_KEY || settings.apiKeys?.claude, ollama: true };
    if (!keyMap[activeProvider]) {
      console.warn(`[Report] ${activeProvider} selected but no API key configured — using expert fallback`);
      const fallbackReport = buildFallbackReport(framework, scores, strengths, gaps, fwCfg);
      return res.json({ remarks: fallbackReport, provider: 'expert-fallback' });
    }

    // --- Create report record ---
    let reportRecord = null;
    if (assessmentId) {
      try {
        reportRecord = await createReport(assessmentId, PROMPT_VERSION);
        await updateReport(reportRecord.id, { generation_status: 'generating' });
      } catch (e) { console.warn('[Report] Could not create report record:', e.message); }
    }

    // --- Build single unified prompt ---
    const prompt = fwCfg.buildPrompt(scores, strengths, gaps);

    // --- Call AI (single request) ---
    let aiResult = { text: null, model: null };
    try {
      console.log(`[Report] Calling ${activeProvider} with unified prompt...`);
      aiResult = await callAIForReport(prompt, settings);
    } catch (e) { console.error('[Report] AI call error:', e); }

    // --- Parse and validate JSON ---
    let reportJson = null;
    if (aiResult.text) {
      let attempt = 0;
      while (attempt < 2 && !reportJson) {
        try {
          // Strip markdown code fences if present
          let cleaned = aiResult.text.trim();
          if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```[a-z]*\n?/, '').replace(/```$/, '').trim();
          }
          const parsed = JSON.parse(cleaned);
          if (validateReportJson(parsed, fwCfg.areas)) {
            reportJson = parsed;
          } else {
            console.warn('[Report] AI JSON failed validation, attempt', attempt + 1);
          }
        } catch (e) {
          console.warn('[Report] JSON parse failed, attempt', attempt + 1, e.message);
        }
        attempt++;
        // Retry once if first attempt failed
        if (!reportJson && attempt < 2) {
          try { aiResult = await callAIForReport(prompt, settings); } catch (_) {}
        }
      }
    }

    // --- Fallback if AI failed or produced invalid output ---
    if (!reportJson) {
      console.warn('[Report] AI output invalid or empty — using expert fallback');
      reportJson = buildFallbackReport(framework, scores, strengths, gaps, fwCfg);
      if (reportRecord) {
        try { await updateReport(reportRecord.id, { generation_status: 'fallback', report_json: reportJson, provider: 'expert-fallback', model: aiResult.model || 'unknown' }); } catch (_) {}
      }
      return res.json({ remarks: reportJson, provider: 'expert-fallback', reportId: reportRecord?.id || null });
    }

    // --- Success: persist and return ---
    if (reportRecord) {
      try {
        await updateReport(reportRecord.id, {
          generation_status: 'completed',
          report_json: reportJson,
          provider: activeProvider,
          model: aiResult.model || activeProvider,
          prompt_version: PROMPT_VERSION,
        });
        // Also update legacy remarks column for backwards compatibility
        await updateAssessmentRemarks(assessmentId, JSON.stringify(reportJson), activeProvider);
      } catch (e) { console.warn('[Report] Could not persist completed report:', e.message); }
    }

    console.log(`[Report] Successfully generated ${framework} report via ${activeProvider}`);
    return res.json({ remarks: reportJson, provider: activeProvider, reportId: reportRecord?.id || null });

  } catch (error) {
    console.error('Remarks API Error:', error);
    try {
      const fallbackReport = buildFallbackReport(framework, scores, {}, {}, fwCfg);
      return res.json({ remarks: fallbackReport, provider: 'expert-fallback' });
    } catch (_) {
      return res.status(500).json({ message: 'Server error generating report' });
    }
  }
});

// Start listening locally — Vercel handles this automatically in production
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 Backend Express server running on port ${PORT}`);
  });
}

// Export the app for Vercel Serverless Functions
export default app;
