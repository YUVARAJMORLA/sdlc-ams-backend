/**
 * frameworkConfig.js
 * Single source of truth for all framework-specific configuration.
 * Add new frameworks here - no other files need to change.
 */

export const PROMPT_VERSION = 'v1.0';

// ---------------------------------------------------------------------------
// Shared maturity level classifier
// ---------------------------------------------------------------------------
export function classifyMaturityLevel(score) {
  if (score >= 4.5) return 'L5: Agentic Enterprise';
  if (score >= 3.5) return 'L4: Autonomous Agent/Workforce';
  if (score >= 2.5) return 'L3: Supervised Agent/Factory';
  if (score >= 1.5) return 'L2: Delegated/Assistant';
  if (score >= 0.5) return 'L1: Assisted/Tool';
  return 'L0: Traditional';
}

// ---------------------------------------------------------------------------
// Shared unified AI prompt builder (one request for all areas)
// ---------------------------------------------------------------------------
export function buildUnifiedPrompt(frameworkName, areas, areaScores, strengths, gaps) {
  const areaLines = areas.map(area => {
    const score = areaScores[area] || 0;
    const level = classifyMaturityLevel(score);
    return JSON.stringify({
      area, score: parseFloat(score.toFixed(2)), maturityLevel: level,
      topStrengths: (strengths[area] || []).slice(0, 5),
      topGaps: (gaps[area] || []).slice(0, 5),
    });
  }).join('\n');

  const areaSchemaLines = areas
    .map(a => `    "${a}": { "analysis": "2-3 sentences.", "strengths": [], "gaps": [], "recommendations": [], "tools": [], "techniques": [] }`)
    .join(',\n');

  return [
    `You are an expert ${frameworkName} AI Maturity Consultant producing a structured assessment report.`,
    '',
    'The deterministic scoring engine calculated these scores. Do NOT change or invent numerical values:',
    areaLines,
    '',
    'Return ONLY a single raw JSON object. No markdown. No code fences. No text before or after.',
    '',
    'Required schema:',
    '{',
    '  "executiveSummary": "2-3 sentence executive summary.",',
    '  "overallInterpretation": "3-4 sentences on posture and key themes.",',
    '  "areas": {',
    areaSchemaLines,
    '  },',
    '  "priorityActions": ["Most urgent action", "Second priority", "Third priority"]',
    '}',
    '',
    'Rules: raw JSON only; executive precise language; specific actionable recommendations; real named tools.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// SDLC Framework
// ---------------------------------------------------------------------------
export const SDLC_CONFIG = {
  name: 'SDLC',
  label: 'Software Development Lifecycle',
  areas: ['Requirements', 'Architecture', 'Development', 'Testing', 'Deployment'],

  fallback: {
    Requirements: {
      process: (s, g) => s.length > 0
        ? `Requirements processes show capability in ${s[0]}. However, ${g[0] || 'backlog grooming'} remains a limitation.`
        : 'Requirements are at a baseline level. Introduce structured framework planning to address backlog definition.',
      tools: 'Jira Product Discovery, Gemini 1.5 Pro, Claude 3.5 Sonnet, and Productboard.',
      techniques: 'Leverage BDD generation and automated user story decomposition via LLM agents.',
    },
    Architecture: {
      process: (s, g) => s.length > 0
        ? `Architecture demonstrates strength in ${s[0]}. A critical governance gap exists in ${g[0] || 'diagram synchronization'}.`
        : 'Architecture workflows run manually without alignment check gates. Automated model checking will prevent divergence.',
      tools: 'Mermaid.js, Eraser.io, Claude 3.5 Sonnet, and ArchUnit.',
      techniques: 'Establish automated ADR creation and code-level architectural drift detection using AST linting rules.',
    },
    Development: {
      process: (s, g) => s.length > 0
        ? `Development shows competency in ${s[0]}. Addressing ${g[0] || 'inline generation templates'} will accelerate velocity.`
        : 'Development relies on local environments. Incorporate structured developer guidelines and unit test suites.',
      tools: 'Cursor IDE, VS Code with GitHub Copilot, and Claude 3.5 Sonnet.',
      techniques: 'Incorporate MCP servers for codebase searching and orchestrate agent-led refactoring and code reviews.',
    },
    Testing: {
      process: (s, g) => s.length > 0
        ? `Testing shows progress in ${s[0]}. However, ${g[0] || 'test case coverage'} presents a major quality bottleneck.`
        : 'Testing practices are manual. Transition to automated test suite execution to reduce regression errors.',
      tools: 'Playwright, Jest, Cypress, and Mockito.',
      techniques: 'Implement agentic test generation, self-healing test suites, and dynamic synthetic mock data synthesis.',
    },
    Deployment: {
      process: (s, g) => s.length > 0
        ? `Deployment shows strength in ${s[0]}. The primary gap is ${g[0] || 'canary deployments'} — greater automation is needed.`
        : 'Deployment pipelines are manually triggered. Automate build and release orchestration to improve delivery security.',
      tools: 'GitHub Actions, ArgoCD, Terraform, and Datadog.',
      techniques: 'Utilize canary deployments with automated rollback verification and AI-driven log analysis.',
    },
  },

  buildPrompt(areaScores, strengths, gaps) {
    return buildUnifiedPrompt(this.name, this.areas, areaScores, strengths, gaps);
  },
};

// ---------------------------------------------------------------------------
// AMS Framework (placeholder - client to supply actual question bank)
// ---------------------------------------------------------------------------
export const AMS_CONFIG = {
  name: 'AMS',
  label: 'Application Management Services',
  // TODO: Replace with actual AMS areas once client supplies the question bank
  areas: ['Service Management', 'Incident Management', 'Change Management', 'Problem Management', 'Release Management'],

  fallback: {
    'Service Management': {
      process: (s, g) => s.length > 0
        ? `Service Management shows maturity in ${s[0]}. Addressing ${g[0] || 'SLA automation'} will improve reliability.`
        : 'Service Management is primarily manual. Introduce AI-driven monitoring and automated SLA enforcement.',
      tools: 'ServiceNow, PagerDuty, and Dynatrace.',
      techniques: 'Deploy AI-driven anomaly detection and automated escalation workflows to reduce MTTR.',
    },
    'Incident Management': {
      process: (s, g) => s.length > 0
        ? `Incident Management demonstrates capability in ${s[0]}. Closing the gap in ${g[0] || 'automated triage'} will reduce MTTR.`
        : 'Incident response relies on manual triage. Implement AI-assisted incident classification.',
      tools: 'PagerDuty, Splunk, and Opsgenie.',
      techniques: 'Implement AI-powered triage with automated runbook execution and predictive failure detection.',
    },
    'Change Management': {
      process: (s, g) => s.length > 0
        ? `Change Management shows strength in ${s[0]}. Improving ${g[0] || 'risk assessment automation'} will reduce change-induced incidents.`
        : 'Change processes lack automated risk assessment. AI-driven impact analysis will improve success rates.',
      tools: 'ServiceNow Change Management and Jira Service Management.',
      techniques: 'Automate change risk scoring, conflict detection, and rollback decision support via AI.',
    },
    'Problem Management': {
      process: (s, g) => s.length > 0
        ? `Problem Management shows progress in ${s[0]}. Addressing ${g[0] || 'root cause automation'} will prevent recurring incidents.`
        : 'Problem Management is reactive. Shift to AI-driven root cause analysis to enable proactive remediation.',
      tools: 'Dynatrace, New Relic, and AI-powered RCA platforms.',
      techniques: 'Implement automated root cause analysis using machine learning on historical incident data.',
    },
    'Release Management': {
      process: (s, g) => s.length > 0
        ? `Release Management demonstrates strength in ${s[0]}. Closing the gap in ${g[0] || 'automated release gates'} will improve confidence.`
        : 'Release processes are manual and error-prone. AI-assisted release gating will reduce deployment risk.',
      tools: 'GitHub Actions, Azure DevOps, and AI-powered quality gates.',
      techniques: 'Deploy AI-driven release readiness assessment and automated regression detection per release candidate.',
    },
  },

  buildPrompt(areaScores, strengths, gaps) {
    return buildUnifiedPrompt(this.name, this.areas, areaScores, strengths, gaps);
  },
};

// ---------------------------------------------------------------------------
// Registry - add new frameworks here only
// ---------------------------------------------------------------------------
export const FRAMEWORK_CONFIG = {
  SDLC: SDLC_CONFIG,
  AMS:  AMS_CONFIG,
};

export const VALID_FRAMEWORKS = Object.keys(FRAMEWORK_CONFIG);

/**
 * Get framework config by name (case-insensitive) or throw a clear error.
 * @param {string} framework
 * @returns {object}
 */
export function getFrameworkConfig(framework) {
  const cfg = FRAMEWORK_CONFIG[String(framework || '').toUpperCase()];
  if (!cfg) {
    throw new Error(
      `Unknown framework "${framework}". Valid frameworks: ${VALID_FRAMEWORKS.join(', ')}`
    );
  }
  return cfg;
}

