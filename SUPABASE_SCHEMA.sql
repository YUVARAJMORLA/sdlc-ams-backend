-- ==============================================================================
-- TCS MaturityIQ — Complete PostgreSQL / Supabase Schema (Blueprint v2.0)
-- Production-grade: 7 tables, FKs, CHECK constraints, auto-triggers, audit log
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- TEARDOWN: Delete previous schema, tables, triggers, and functions cleanly
-- ------------------------------------------------------------------------------
DROP TABLE IF EXISTS audit_log CASCADE;
DROP TABLE IF EXISTS feedback CASCADE;
DROP TABLE IF EXISTS assessment_reports CASCADE;
DROP TABLE IF EXISTS assessments CASCADE;
DROP TABLE IF EXISTS questions CASCADE;
DROP TABLE IF EXISTS settings CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE;

-- ------------------------------------------------------------------------------
-- 0. Triggers & Helper Functions
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------------------------
-- TABLE 1: users
-- ------------------------------------------------------------------------------
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

-- ------------------------------------------------------------------------------
-- TABLE 2: questions
-- ------------------------------------------------------------------------------
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
  updated_at    TIMESTAMP    DEFAULT NOW(),
  CONSTRAINT uq_questions_practice UNIQUE (framework, area, sub_area, practice)
);
CREATE INDEX IF NOT EXISTS idx_questions_framework ON questions(framework);
CREATE INDEX IF NOT EXISTS idx_questions_area ON questions(area);

-- ------------------------------------------------------------------------------
-- TABLE 3: assessments
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assessments (
  id               VARCHAR(50)  PRIMARY KEY,
  user_id          VARCHAR(50)  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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

-- ------------------------------------------------------------------------------
-- TABLE 4: assessment_reports
-- ------------------------------------------------------------------------------
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

-- ------------------------------------------------------------------------------
-- TABLE 5: feedback
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feedback (
  id             VARCHAR(50)  PRIMARY KEY,
  assessment_id  VARCHAR(50)  NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  user_id        VARCHAR(50)  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_email     VARCHAR(255),
  rating         SMALLINT     NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comments       TEXT,
  created_at     TIMESTAMP    DEFAULT NOW(),
  updated_at     TIMESTAMP    DEFAULT NOW(),
  CONSTRAINT uq_feedback_user_assessment UNIQUE (assessment_id, user_id)
);

-- ------------------------------------------------------------------------------
-- TABLE 6: settings
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  id                  SMALLINT     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  active_ai_provider  VARCHAR(50)  DEFAULT 'gemini' CHECK (active_ai_provider IN ('openai','gemini','claude','ollama','expert')),
  api_keys            JSONB        DEFAULT '{"openai":"","gemini":"","claude":""}',
  api_endpoints       JSONB        DEFAULT '{"openai":"","gemini":"","claude":"","ollama":""}',
  ollama_url          VARCHAR(255) DEFAULT 'http://localhost:11434',
  ollama_model        VARCHAR(100) DEFAULT 'llama3',
  updated_at          TIMESTAMP    DEFAULT NOW()
);

-- ------------------------------------------------------------------------------
-- TABLE 7: audit_log
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       VARCHAR(50)  REFERENCES users(id) ON DELETE SET NULL,
  action        VARCHAR(100) NOT NULL,
  entity_type   VARCHAR(50),
  entity_id     VARCHAR(100),
  old_values    JSONB,
  new_values    JSONB,
  ip_address    TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMP    DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC);

-- ------------------------------------------------------------------------------
-- Triggers for auto-updating updated_at
-- ------------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trigger_update_updated_at_users ON users;
CREATE TRIGGER trigger_update_updated_at_users
BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_update_updated_at_questions ON questions;
CREATE TRIGGER trigger_update_updated_at_questions
BEFORE UPDATE ON questions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_update_updated_at_assessments ON assessments;
CREATE TRIGGER trigger_update_updated_at_assessments
BEFORE UPDATE ON assessments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_update_updated_at_assessment_reports ON assessment_reports;
CREATE TRIGGER trigger_update_updated_at_assessment_reports
BEFORE UPDATE ON assessment_reports FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_update_updated_at_feedback ON feedback;
CREATE TRIGGER trigger_update_updated_at_feedback
BEFORE UPDATE ON feedback FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_update_updated_at_settings ON settings;
CREATE TRIGGER trigger_update_updated_at_settings
BEFORE UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------------------------
-- Seed: Default Admin User (admin@sdlc.com / admin123)
-- ------------------------------------------------------------------------------
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

-- ------------------------------------------------------------------------------
-- Seed: Default Settings
-- ------------------------------------------------------------------------------
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

-- ------------------------------------------------------------------------------
-- Seed: SDLC Questions (120 Questions)
-- ------------------------------------------------------------------------------
INSERT INTO questions (id, area, sub_area, practice, type, question_text) VALUES
(1,'Requirements','Product Discovery & Ideation','Idea generation & exploration','extent','To what extent does your team use AI for idea generation & exploration?'),
(2,'Requirements','Product Discovery & Ideation','Problem discovery & framing','extent','To what extent does your team use AI for problem discovery & framing?'),
(3,'Requirements','Requirement Engineering','Requirements elicitation and analysis','extent','To what extent does your team use AI for requirements elicitation and analysis?'),
(4,'Requirements','Requirement Engineering','Technical feasibility and risk assessment','extent','To what extent does your team use AI for technical feasibility and risk assessment?'),
(5,'Requirements','Requirement Prioritization & Road‑mapping','Dependency & sequencing analysis','extent','To what extent does your team use AI for dependency & sequencing analysis?'),
(6,'Requirements','Requirement Prioritization & Road‑mapping','Requirement prioritization & trade‑off analysis','extent','To what extent does your team use AI for requirement prioritization & trade‑off analysis?'),
(7,'Requirements','Requirement Prioritization & Road‑mapping','Roadmap scenario planning','extent','To what extent does your team use AI for roadmap scenario planning?'),
(8,'Requirements','Requirements','Backlog Refinement','extent','To what extent is the following true in your current practice: AI decomposes vague backlog items into sized features with acceptance criteria. The engineer''s role is to judge and adjust AI output, not to write stories from a blank page.'),
(9,'Requirements','Requirements','Bidirectional Traceability','extent','To what extent is the following true in your current practice: The agent maintains and enforces traceability automatically on every PR. The engineer sets the traceability policy once; the agent applies it continuously without prompting.'),
(10,'Requirements','Requirements','Effort, Cost & Risk Simulation','extent','To what extent is the following true in your current practice: The agent monitors cost and risk continuously against thresholds the team has set, and alerts automatically when they are breached. Humans are not periodically reviewing a spreadsheet - the system comes to them.'),
(11,'Requirements','Requirements','Impact Analysis','extent','To what extent is the following true in your current practice: An agent independently traces a change request across the codebase and produces an impact matrix. The engineer validates the output - they do not do the tracing themselves.'),
(12,'Requirements','Requirements','OCM & Course Correction','extent','To what extent is the following true in your current practice: The system catches scope or risk drift and raises it before a human notices. If a human is always the one spotting drift, this practice is not Achieved.'),
(13,'Requirements','Requirements','Root-to-Live Discovery & Sequencing','extent','To what extent is the following true in your current practice: When scope changes, the system replans automatically and escalates only when sequencing decisions exceed defined risk thresholds. A human does not replan by hand - they approve or override the agent''s plan.'),
(14,'Requirements','Requirements','Transcript → Requirements','extent','To what extent is the following true in your current practice: The first draft of every requirement comes from AI processing meeting notes or transcripts - not from a human writing from scratch. The engineer directs, refines, and approves; authoring is AI''s job.'),
(15,'Requirements','User Experience & Insights','Experience pain‑point identification','extent','To what extent does your team use AI for experience pain‑point identification?'),
(16,'Requirements','User Experience & Insights','Feedback & sentiment analysis','extent','To what extent does your team use AI for feedback & sentiment analysis?'),
(17,'Requirements','User Experience & Insights','Persona & journey modeling','extent','To what extent does your team use AI for persona & journey modeling?'),
(18,'Requirements','User Experience & Insights','User research synthesis','extent','To what extent does your team use AI for user research synthesis?'),
(19,'Architecture','Architecture','Architecture Synthesiser','extent','To what extent is the following true in your current practice: An agent produces target-state blueprint options with trade-off analysis. The architect selects and approves a direction - they do not synthesise options themselves. The agent does the synthesis work.'),
(20,'Architecture','Architecture','Auto-Generate Architecture Diagrams','extent','To what extent is the following true in your current practice: The first version of any architecture diagram is AI-generated from code, IaC, or natural language. An engineer directing AI to produce a diagram, then refining it, is the standard workflow - not an engineer drawing from scratch.'),
(21,'Architecture','Architecture','Automated Drift Remediation','extent','To what extent is the following true in your current practice: Low-risk drift is remediated and shipped automatically when tests pass and the change meets defined guardrails. Humans are only pulled in when the drift is high-risk or the guardrails cannot classify it. Humans set the guardrails - the agent enforces them.'),
(22,'Architecture','Architecture','Compliance & Security Policy Advisor','extent','To what extent is the following true in your current practice: The system notices a compliance gap before a person does and raises it automatically. If a human is the one discovering policy violations, the monitoring is not at this level.'),
(23,'Architecture','Architecture','Drift Detection in PRs','extent','To what extent is the following true in your current practice: The agent inspects every PR for architecture drift and can block a clear violation without a human stepping in. If a human must read every PR to catch drift, the gate is not real.'),
(24,'Architecture','Architecture','Extract Architecture from Code','extent','To what extent is the following true in your current practice: AI reads the codebase and generates architecture documentation and component maps. Engineers do not draw diagrams from memory - they review and correct AI-generated output. Critically, the AI can see the actual codebase, not just generic knowledge.'),
(25,'Architecture','Architecture','FinOps Modeller & Planner','extent','To what extent is the following true in your current practice: The agent flags architecture cost implications and overspend automatically against thresholds the team has set. Cost decisions are not discovered in a monthly review - the system surfaces them in real time.'),
(26,'Architecture','Architecture & Design Governance','Architecture & Design Quality Governance','extent','To what extent does your team use AI for architecture & design quality governance?'),
(27,'Architecture','Architecture & Design Governance','Architecture Decision Governance & Traceability','extent','To what extent does your team use AI for architecture decision governance & traceability?'),
(28,'Architecture','Architecture & Design Governance','Architecture Decision Knowledge management','extent','To what extent does your team use AI for architecture decision knowledge management?'),
(29,'Architecture','Architecture & Design Governance','Architecture Decision Review & Approval Governance','extent','To what extent does your team use AI for architecture decision review & approval governance?'),
(30,'Architecture','Architecture & Design Governance','Architecture and design reviews','extent','To what extent does your team use AI for architecture and design reviews?'),
(31,'Architecture','Architecture & Design Governance','Candidate Architecture Generation','extent','To what extent does your team use AI for candidate architecture generation?'),
(32,'Architecture','Architecture & Design Governance','Decision traceability','extent','To what extent does your team use AI for decision traceability?'),
(33,'Architecture','Architecture & Design Governance','Design Documentation Governance & Traceability (or) Design Traceability Management','extent','To what extent does your team use AI for design documentation governance & traceability (or) design traceability management?'),
(34,'Architecture','Legacy Modernization & Decomposition','System Decomposition Analysis','extent','To what extent does your team use AI for system decomposition analysis?'),
(35,'Development','Build Process Management','Build Artifact generation and storage','extent','To what extent does your team use AI for build artifact generation and storage?'),
(36,'Development','Build Process Management','Build Automation Engineering','extent','To what extent does your team use AI for build automation engineering?'),
(37,'Development','Build Process Management','Build Execution','extent','To what extent does your team use AI for build execution?'),
(38,'Development','Build Process Management','Build Failure Management','extent','To what extent does your team use AI for build failure management?'),
(39,'Development','Build Process Management','Build performance optimization','extent','To what extent does your team use AI for build performance optimization?'),
(40,'Development','Code Development & Review','Code Branching & Merge Governance','extent','To what extent does your team use AI for code branching & merge governance?'),
(41,'Development','Code Development & Review','Code Generation','extent','To what extent does your team use AI for code generation?'),
(42,'Development','Code Development & Review','Code Quality Standards Governance & Enforcement','extent','To what extent does your team use AI for code quality standards governance & enforcement?'),
(43,'Development','Code Development & Review','Code Review','extent','To what extent does your team use AI for code review?'),
(44,'Development','Code Development & Review','Code base Management','extent','To what extent does your team use AI for code base management?'),
(45,'Development','Code Development & Review','Code refactoring and optimization','extent','To what extent does your team use AI for code refactoring and optimization?'),
(46,'Development','Code Development & Review','Defect prevention and resolution','extent','To what extent does your team use AI for defect prevention and resolution?'),
(47,'Development','Code Development & Review','Security Vulnerability','extent','To what extent does your team use AI for security vulnerability?'),
(48,'Development','Configuration & Dependency Management','Configuration file management','extent','To what extent does your team use AI for configuration file management?'),
(49,'Development','Configuration & Dependency Management','Dependency management','extent','To what extent does your team use AI for dependency management?'),
(50,'Development','Configuration & Dependency Management','Source & Version Management Governance','extent','To what extent does your team use AI for source & version management governance?'),
(51,'Development','Development','AI Coding Assistant - Agent Mode','extent','To what extent is the following true in your current practice: Every engineer uses AI in agent mode for multi-step tasks - not just autocomplete. If removing AI tools would only affect speed and leave the process unchanged, this is the level the team is at.'),
(52,'Development','Development','AI-Assisted Code Review','extent','To what extent is the following true in your current practice: AI participates in every code review, flagging bugs and security issues. A human reads every flag and makes the final call - the AI accelerates the reviewer, it does not replace the human gate.'),
(53,'Development','Development','Custom Agents via MCP & Scripts','extent','To what extent is the following true in your current practice: An agent can open a pull request on its own without a human writing the change by hand. The human''s role is to review and approve the PR - not to author the code. This is the line between L1 and L2.'),
(54,'Development','Development','Custom Instructions & Skills','extent','To what extent is the following true in your current practice: AI can see the team''s own codebase, standards, and project context - not just generic public knowledge. Custom instructions or skills are in place so the agent is project-aware by default, not by the engineer pasting context manually each time.'),
(55,'Development','Development','Long-Running Agentic Tasks','extent','To what extent is the following true in your current practice: Agents operate autonomously over extended periods. The safety net - automated rollback, fast catch-and-undo - is what makes this level achievable. If a wrong agent action cannot be caught and reversed quickly, the team cannot safely operate here.'),
(56,'Development','Development','Orchestrator & Sub-Agent Architecture','extent','To what extent is the following true in your current practice: Complex tasks are handled by orchestrated multi-agent systems that plug into a shared internal platform - not individual engineers wiring up their own tools. Humans set the guardrails and escalation rules; agents handle execution and peer review within those rules.'),
(57,'Development','Technical Debt & Refactoring','Code Quality Measurement & Governance','extent','To what extent does your team use AI for code quality measurement & governance?'),
(58,'Development','Technical Debt & Refactoring','Legacy code modernization','extent','To what extent does your team use AI for legacy code modernization?'),
(59,'Development','Technical Debt & Refactoring','Refactoring Governance & Prioritization','extent','To what extent does your team use AI for refactoring governance & prioritization?'),
(60,'Development','Technical Debt & Refactoring','Technical debt identification','extent','To what extent does your team use AI for technical debt identification?'),
(61,'Development','Unit & Component Testing','Unit Test coverage','extent','To what extent does your team use AI for unit test coverage?'),
(62,'Development','Unit & Component Testing','Unit test execution','extent','To what extent does your team use AI for unit test execution?'),
(63,'Development','Unit & Component Testing','Unit test generation','extent','To what extent does your team use AI for unit test generation?'),
(64,'Testing','Defect Management','Bug reproducibility insights','extent','To what extent does your team use AI for bug reproducibility insights?'),
(65,'Testing','Defect Management','Defect Classification','extent','To what extent does your team use AI for defect classification?'),
(66,'Testing','Defect Management','Defect Triaging','extent','To what extent does your team use AI for defect triaging?'),
(67,'Testing','Defect Management','Defect prioritization','extent','To what extent does your team use AI for defect prioritization?'),
(68,'Testing','Defect Management','Defect reporting','extent','To what extent does your team use AI for defect reporting?'),
(69,'Testing','Defect Management','Defect resolution process','extent','To what extent does your team use AI for defect resolution process?'),
(70,'Testing','Defect Management','Defect tracking','extent','To what extent does your team use AI for defect tracking?'),
(71,'Testing','Defect Management','Executive summary generation','extent','To what extent does your team use AI for executive summary generation?'),
(72,'Testing','Test Automation Governance','CI integration for test automation','extent','To what extent does your team use AI for ci integration for test automation?'),
(73,'Testing','Test Automation Governance','Test Automation Enablement & Governance','extent','To what extent does your team use AI for test automation enablement & governance?'),
(74,'Testing','Test Automation Governance','Test Script Lifecycle Management','extent','To what extent does your team use AI for test script lifecycle management?'),
(75,'Testing','Test Automation Governance','Test automation strategy','extent','To what extent does your team use AI for test automation strategy?'),
(76,'Testing','Test Design & Development','Test Automation Architecture & Enablement','extent','To what extent does your team use AI for test automation architecture & enablement?'),
(77,'Testing','Test Design & Development','Test Coverage','extent','To what extent does your team use AI for test coverage?'),
(78,'Testing','Test Design & Development','Test Generation','extent','To what extent does your team use AI for test generation?'),
(79,'Testing','Test Design & Development','Test Prioritization','extent','To what extent does your team use AI for test prioritization?'),
(80,'Testing','Test Design & Development','Test case development and traceability','extent','To what extent does your team use AI for test case development and traceability?'),
(81,'Testing','Test Design & Development','Test data management','extent','To what extent does your team use AI for test data management?'),
(82,'Testing','Test Execution & Reporting','Defect logging and triage','extent','To what extent does your team use AI for defect logging and triage?'),
(83,'Testing','Test Execution & Reporting','Flaky test detection','extent','To what extent does your team use AI for flaky test detection?'),
(84,'Testing','Test Execution & Reporting','Test Environment Scaling','extent','To what extent does your team use AI for test environment scaling?'),
(85,'Testing','Test Execution & Reporting','Test Execution Reporting & Quality Insights','extent','To what extent does your team use AI for test execution reporting & quality insights?'),
(86,'Testing','Test Execution & Reporting','Test Quality Evidence & Insights Management','extent','To what extent does your team use AI for test quality evidence & insights management?'),
(87,'Testing','Test Execution & Reporting','Test Scripting','extent','To what extent does your team use AI for test scripting?'),
(88,'Testing','Test Execution & Reporting','Test Suite Optimization','extent','To what extent does your team use AI for test suite optimization?'),
(89,'Testing','Test Execution & Reporting','Test environment management','extent','To what extent does your team use AI for test environment management?'),
(90,'Testing','Test Execution & Reporting','Test execution planning & Orchestration','extent','To what extent does your team use AI for test execution planning & orchestration?'),
(91,'Testing','Test Strategy & Planning','Define test objectives and scope','extent','To what extent does your team use AI for define test objectives and scope?'),
(92,'Testing','Test Strategy & Planning','Identify test types and levels','extent','To what extent does your team use AI for identify test types and levels?'),
(93,'Testing','Test Strategy & Planning','Resource and environment planning','extent','To what extent does your team use AI for resource and environment planning?'),
(94,'Testing','Test Strategy & Planning','Risk-based test prioritization','extent','To what extent does your team use AI for risk-based test prioritization?'),
(95,'Testing','Testing','E2E Test Execution Workflow','extent','To what extent is the following true in your current practice: The system can block a bad change without a human clicking approve. Agents generate, run, and triage failures automatically. If a human must approve every test run result, the quality gate is not real.'),
(96,'Testing','Testing','Non-Functional & Performance Testing','extent','To what extent is the following true in your current practice: SLA thresholds are set by the team; the agent enforces them on every change. Non-functional regressions are caught automatically - a human does not spot them in a periodic performance review.'),
(97,'Testing','Testing','Offline Evaluation of AI Features','extent','To what extent is the following true in your current practice: For any feature with an AI component, the agent runs structured evals against a golden dataset before code ships. The human sets the golden dataset and pass threshold once; the agent enforces it on every change.'),
(98,'Testing','Testing','Synthetic Test Data Creation','extent','To what extent is the following true in your current practice: The agent generates test data at scale from schema definitions and edge-case rules set by the engineer. A human does not curate or maintain test datasets manually - the agent produces them on demand.'),
(99,'Testing','Testing','Test Case Generation','extent','To what extent is the following true in your current practice: AI generates test cases from requirements covering happy paths, edge cases, and negative scenarios. A human reviews and selects which cases to use - the engineer does not write test cases from scratch.'),
(100,'Testing','Testing','Test Script Generation','extent','To what extent is the following true in your current practice: Tests run automatically on every change - triggered by the pipeline, not by a human. The agent generates and executes scripts; a human reviews results and decides whether to proceed to the next stage.'),
(101,'Testing','Testing','Vulnerability Simulation','extent','To what extent is the following true in your current practice: Adversarial probes and prompt injection tests run as part of every standard pipeline. Security regressions are caught by the system before anyone on the team notices - not by periodic manual pen testing.'),
(102,'Deployment','CD / CI-CD','Automated Release Notes','extent','To what extent is the following true in your current practice: An agent generates release notes from commit history and PRs. The engineer approves before distribution - they do not write release notes by hand.'),
(103,'Deployment','CD / CI-CD','Capacity Prediction','extent','To what extent is the following true in your current practice: The system predicts capacity needs and triggers scaling recommendations before engineers react to a problem. If scaling decisions are made reactively by a human watching metrics, this is not Achieved.'),
(104,'Deployment','CD / CI-CD','Deployment Script Generation','extent','To what extent is the following true in your current practice: AI generates deployment scripts, Helm charts, and YAML manifests. The engineer reviews and triggers deployment - they do not write deployment config from scratch.'),
(105,'Deployment','CD / CI-CD','Initial Triage Assistance','extent','To what extent is the following true in your current practice: When something breaks in production, a system notices and surfaces probable causes before an engineer manually investigates. If an engineer is always the first to notice an incident, this practice is not Achieved.'),
(106,'Deployment','CD / CI-CD','Root Cause Analysis (RCA)','extent','To what extent is the following true in your current practice: When something breaks, a system triages it and produces a structured RCA before a human investigates. The engineer validates and acts on the analysis - they do not start the investigation from raw logs.'),
(107,'Deployment','CD / CI-CD','Runtime FinOps Optimisation','extent','To what extent is the following true in your current practice: The agent rightsizes resources and terminates idle instances automatically within cost thresholds the team has set. Cost is not managed by a human reviewing spend reports - the system optimises continuously.'),
(108,'Deployment','CD / CI-CD','Self-Healing Systems','extent','To what extent is the following true in your current practice: When a service degrades, the system catches it, executes remediation, and - if the fix meets the defined guardrails - resolves it before anyone on the team knows it happened. Humans are pulled in only for ambiguous or high-risk incidents.'),
(109,'Deployment','CI / CI-CD','AI-Integrated Quality Gates','extent','To what extent is the following true in your current practice: AI quality checks - linting, security scanning, coverage - run automatically on every commit. A human reads the results and decides whether to proceed. The checks run themselves; the human is still the gate.'),
(110,'Deployment','CI / CI-CD','Agents Integrated in CI via API','extent','To what extent is the following true in your current practice: AI agents run as first-class CI pipeline steps via API, performing analysis and validation as part of the automated build. The agent acts in the pipeline; a human reviews output before merge.'),
(111,'Deployment','CI / CI-CD','Code Quality, AI Slop & Data Lineage Reporting','extent','To what extent is the following true in your current practice: The system blocks quality regressions and low-quality AI-generated code automatically on every pipeline run. A human does not periodically audit for code quality - the gate is always on.'),
(112,'Deployment','CI / CI-CD','OSS, Deprecated Code & Evergreening Scans','extent','To what extent is the following true in your current practice: Low-risk dependency updates and evergreening PRs ship automatically within guardrails the team has set. A human does not review every maintenance PR - the system handles routine updates and escalates only non-routine ones.'),
(113,'Deployment','CI / CI-CD','Pipeline Creation Using AI','extent','To what extent is the following true in your current practice: An agent generates CI pipeline configuration from requirements. The engineer reviews and approves - they do not write YAML or pipeline scripts from scratch.'),
(114,'Deployment','CI / CI-CD','Shift-Left Agents in Developer IDE','extent','To what extent is the following true in your current practice: The same agents that run in CI are available in the developer''s IDE via a shared platform (MCP), not individually wired up by each engineer. Issues are caught before commit using the same rules as CI.'),
(115,'Deployment','Continuous Integration & Delivery','CI/CD Flow Optimization & Throughput Engineering','extent','To what extent does your team use AI for ci/cd flow optimization & throughput engineering?'),
(116,'Deployment','Continuous Integration & Delivery','Continuous Integration & Deployment Automation','extent','To what extent does your team use AI for continuous integration & deployment automation?'),
(117,'Deployment','Continuous Integration & Delivery','Pipeline Reliability Forecasting & Prevention','extent','To what extent does your team use AI for pipeline reliability forecasting & prevention?'),
(118,'Deployment','Continuous Integration & Delivery','Release Risk Assessment & Controls','extent','To what extent does your team use AI for release risk assessment & controls?'),
(119,'Deployment','Continuous Integration & Delivery','Release Rollback & Recovery Management','extent','To what extent does your team use AI for release rollback & recovery management?'),
(120,'Deployment','Continuous Integration & Delivery','Release gating and approvals','extent','To what extent does your team use AI for release gating and approvals?') ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------
-- Seed: AMS Questions (10 questions, 2 per area, framework=AMS)
-- ---------------------------------------------------------------
INSERT INTO questions (id, framework, area, sub_area, practice, type, question_text) VALUES
(201,'AMS','Service Management','Service Catalogue & SLA Governance','AI-Driven SLA Monitoring & Alerting','extent','To what extent is the following true in your current practice: SLA thresholds are monitored by an AI agent that alerts automatically before a breach occurs. A human does not poll dashboards to detect SLA risk — the system surfaces it proactively and triggers escalation.'),
(202,'AMS','Service Management','Service Request Automation','Self-Service Request Fulfilment','extent','To what extent does your team use AI to automatically classify, route, and fulfil service requests without human triage for routine requests? An agent handles standard requests end-to-end; a human only steps in for exceptions.'),
(203,'AMS','Incident Management','Incident Triage & Classification','AI-Powered Incident Triage','extent','To what extent is the following true in your current practice: Every incoming incident is automatically classified, prioritised, and assigned by an AI agent based on historical patterns and impact scoring. A human does not perform initial triage — the agent does, and the human validates or overrides.'),
(204,'AMS','Incident Management','Automated Runbook Execution','Runbook Automation & Self-Healing','extent','To what extent does your team use AI agents to execute runbooks automatically during incidents? The agent identifies the applicable runbook, executes remediation steps, and resolves the incident without human intervention for known failure modes.'),
(205,'AMS','Change Management','Change Risk Assessment','AI-Driven Change Risk Scoring','extent','To what extent is the following true in your current practice: Every change request is automatically risk-scored by an AI model before a human reviews it. The risk score, predicted blast radius, and conflict analysis are produced by the system — not estimated manually by the change manager.'),
(206,'AMS','Change Management','Change Impact Analysis','Automated Conflict & Impact Detection','extent','To what extent does your team use AI to automatically detect scheduling conflicts, downstream service impacts, and dependency risks for proposed changes? The agent produces an impact matrix; the change advisory board reviews AI output rather than building the analysis from scratch.'),
(207,'AMS','Problem Management','Root Cause Analysis Automation','AI-Assisted Root Cause Analysis','extent','To what extent is the following true in your current practice: When a problem record is raised, an AI agent automatically correlates related incidents, analyses log patterns, and produces a structured root cause hypothesis. The problem manager validates the AI output — they do not start analysis from raw data.'),
(208,'AMS','Problem Management','Proactive Problem Detection','Predictive Anomaly & Problem Detection','extent','To what extent does your team use AI to proactively detect emerging problems before they cause user-impacting incidents? An agent continuously analyses telemetry and raises problem records when anomaly patterns match known failure signatures — humans are not the first to notice degradation.'),
(209,'AMS','Release Management','Release Readiness Assessment','AI-Powered Release Gate Assessment','extent','To what extent is the following true in your current practice: An AI agent evaluates release readiness by aggregating test coverage, open defects, change risk scores, and deployment history into a structured go/no-go recommendation. The release manager reviews the AI recommendation — they do not compile the readiness evidence manually.'),
(210,'AMS','Release Management','Automated Release Orchestration','End-to-End Release Pipeline Orchestration','extent','To what extent does your team use AI agents to orchestrate the end-to-end release pipeline — coordinating environment provisioning, smoke tests, approval workflows, and rollback triggers automatically? The release engineer sets guardrails and approves the final gate; the agent executes and monitors the pipeline.') ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------------------------
-- Reset serial sequence to prevent duplicate key errors on new question inserts
-- ------------------------------------------------------------------------------
SELECT setval('questions_id_seq', (SELECT COALESCE(MAX(id), 1) FROM questions));
