# NextGen Agent Architecture

## Design Document v2.0

This document describes the architecture for long-running autonomous coding agents that can handle complex, multi-day tasks like migrating an application from one framework to another.

**Key Changes from v1.0:**
- Added Domain Memory System for cross-session persistence
- Added Feature level (atomic, testable units) to hierarchy
- Test-bound status (agents can't claim success without tests passing)
- Initializer/Worker agent pattern
- Session initialization with context hydration

---

## Table of Contents

1. [Overview](#overview)
2. [Design Philosophy](#design-philosophy)
3. [Core Concepts](#core-concepts)
4. [Architecture](#architecture)
5. [Domain Memory System](#domain-memory-system)
6. [Code Discovery System](#code-discovery-system)
7. [Decision Tier System](#decision-tier-system)
8. [Session Model & Initialization](#session-model--initialization)
9. [Parallel Exploration](#parallel-exploration)
10. [AI Review System](#ai-review-system)
11. [Notification System](#notification-system)
12. [Key Flows](#key-flows)
13. [Persistence Model](#persistence-model)
14. [Cost Management](#cost-management)
15. [File Structure](#file-structure)

---

## Overview

The NextGen agent architecture is designed for **long-running autonomous coding tasks** that may span hours or days. Unlike simple single-turn agents, these agents must:

- Break down large tasks into reviewable milestones
- Make decisions autonomously while knowing when to ask humans
- Handle context limitations through session forking and sub-agents
- Explore multiple implementation approaches when uncertain
- Learn from past work to improve code quality
- Keep humans informed without requiring constant attention
- **Resume from any point with full context** (domain memory)
- **Verify progress through tests and a separate review agent, not the implementing agent claims** (test-bound status)

### Example Use Case

> "Migrate this Fastify/Angular application to Next.js"

This task might involve:
- 50+ files to modify
- Multiple architectural decisions (routing strategy, state management, etc.)
- Several days of autonomous work
- Periodic human checkpoints for review and guidance
- **Dozens of individual features, each with its own test**

---

## Design Philosophy

### 1. Session Management over Context Compaction

**Problem**: Long-running agents exhaust context windows. Traditional approaches compress/summarize context, losing important details.

**Solution**: Use two session strategies instead of compaction:

1. **Fresh Sessions for Features**: Start clean, inject context from domain memory
2. **Forked Sessions for Exploration**: Inherit parent context when exploring options

```
Parent Orchestrator (maintains task state via domain memory)
    │
    ├── Feature 1 (fresh session, context from goals/status/progress)
    ├── Feature 2 (fresh session, context from goals/status/progress)
    │
    └── Decision: explore 2 approaches for Feature 3
        ├── Forked Session A (worktree 1, explores option A)
        └── Forked Session B (worktree 2, explores option B)
```

### 2. Test-Bound Status with Separate Review Agent

**Problem**: Agents can hallucinate success. "I fixed the bug" doesn't mean the bug is fixed.

**Solution**: Two-stage verification with separate implementing and reviewing agents:

```
Implementing Agent marks feature "completed"
    │
    ▼
┌─────────────────────────────────────┐
│  STAGE 1: Test Gate                 │
│  System runs testCommand            │
└──────────────┬──────────────────────┘
               │
    ┌──────────┴──────────┐
    ▼                     ▼
  FAIL                  PASS
    │                     │
    ▼                     ▼
Status = failing    ┌─────────────────────────────────────┐
Attempt++           │  STAGE 2: Review Agent              │
Return to           │  (Separate agent, fresh session)    │
implementor         │                                     │
                    │  • Checks code quality              │
                    │  • Verifies test coverage           │
                    │  • Checks against KB patterns       │
                    │  • Detects regressions              │
                    │  • Reviews previous decisions       │
                    └──────────────┬──────────────────────┘
                                   │
                        ┌──────────┴──────────┐
                        ▼                     ▼
                    APPROVED              CHANGES_REQUESTED
                        │                     │
                        ▼                     ▼
                  Status = passing      Status = failing
                  Record in             Record feedback
                  reviews.json          + reviewer decision
                                        Return to implementor
```

**Key principle**: The implementing agent and review agent are separate. The reviewer's decisions are recorded to prevent oscillation (reviewer changing designs back and forth).

This ensures:
- Cross-session truth (new sessions know what actually works)
- Audit trail (progress.md shows what was tried)
- Human trust (status reflects reality)
- **No circular design changes** (reviewer history prevents flip-flopping)

### 3. Domain Memory Persistence

**Problem**: Each session starts as an amnesiac with no sense of where it is.

**Solution**: Persistent domain memory files that survive sessions:

| File | Purpose | Mutability |
|------|---------|------------|
| `goals.yaml` | What we want to achieve | Stable, human-editable |
| `status.json` | What's verified true | Machine-updated by tests |
| `progress.md` | What happened (audit) | Append-only |
| `context.md` | What agent needs now | Regenerated each session |

### 4. Task Hierarchy

**Task → Milestone → Subtask → Feature**

- **Task**: The overall goal (e.g., "Migrate to Next.js")
- **Milestone**: A reviewable checkpoint with human approval option
- **Subtask**: A logical grouping of related work
- **Feature**: An atomic unit with a test command (the unit of work)

### 5. Leverage Claude's Training

Claude has been trained to use TodoWrite effectively. Rather than fight this:
- Use TodoWrite for **within-session display** (real-time progress)
- Use domain memory for **cross-session state** (persistent truth)
- Sync between them at session boundaries

### 6. Parallel Exploration for Uncertainty

When human input would cause idle time, don't just wait:
- Launch parallel explorations in git worktrees
- Both options work on the **same feature**
- AI or human selects winner
- Record winning approach in progress.md

### 7. Trust but Verify

Most decisions are fine to make autonomously. Only escalate when:
- The decision significantly impacts architecture
- Multiple approaches have genuinely different trade-offs
- The agent is uncertain about user preferences
- **Max attempts reached without tests passing**

---

## Core Concepts

### Task Definition

```typescript
interface TaskDefinition {
  id: string;
  description: string;
  scope: ScopeDefinition;
  milestones: Milestone[];
  constraints?: string[];
  preferences?: string[];
}
```

### Milestone

A reviewable checkpoint that represents meaningful progress:

```typescript
interface Milestone {
  id: string;
  name: string;
  description: string;
  status: 'pending' | 'in_progress' | 'passing' | 'blocked';
  dependsOn: string[];
  subtasks: Subtask[];
  requiresHumanReview: boolean;
  completionCriteria: string[];
}
```

### Subtask

A logical grouping of related features:

```typescript
interface Subtask {
  id: string;
  name: string;
  description: string;
  features: Feature[];
}
```

### Feature (NEW)

The atomic unit of work with test binding:

```typescript
interface Feature {
  id: string;
  description: string;
  testCommand: string;           // How to verify this feature
  dependsOn: string[];           // Other feature IDs
  estimatedComplexity: 'low' | 'medium' | 'high';
}

interface FeatureStatus {
  status: 'pending' | 'in_progress' | 'passing' | 'failing' | 'blocked';
  lastTest?: string;             // ISO timestamp
  lastTestDuration?: number;     // milliseconds
  attempts: number;
  maxAttempts: number;           // default: 3
  lastError?: string;
  commits: string[];
}
```

### Feature Test Configuration

Testing operates at two levels:

1. **Project Level** — Always runs (`pnpm test`)
2. **Feature Level** — Optional additional configuration per feature

#### Feature TestConfig Schema

```typescript
interface Feature {
  id: string
  description: string
  dependsOn: string[]

  // Optional: feature-specific test configuration
  testConfig?: FeatureTestConfig
}

interface FeatureTestConfig {
  // Optimization: only run when these paths change
  triggerPaths?: string[]

  // Additional test commands beyond project tests
  additional?: string | string[]

  // LLM-as-judge evaluation (inline or reference)
  llmJudge?: LlmJudgeConfig | { $ref: string }

  // Manual verification escape hatch
  manual?: {
    required: boolean
    instructions: string
  }
}

interface LlmJudgeConfig {
  model: string                              // e.g., "claude-sonnet-4-20250514"
  testCases: TestCase[] | { $ref: string }   // Inline or external file
  evaluationCriteria: string[]
  passThreshold: number                      // e.g., 0.8
}

interface TestCase {
  input: string
  expectedBehavior: string
}
```

#### Examples by Feature Type

**Simple feature (no config):**
```yaml
- id: ft-auth-login
  description: "Implement login flow"
  # No testConfig = just project tests
```

**Scoped feature (run subset of tests):**
```yaml
- id: ft-rate-limit
  description: "Add API rate limiting"
  testConfig:
    triggerPaths: ["src/middleware/rateLimit/**"]
```

**Feature with additional E2E tests:**
```yaml
- id: ft-stripe-integration
  description: "Add Stripe payment processing"
  testConfig:
    additional: "pnpm test:payments:e2e"
```

**Feature with LLM evaluation (inline):**
```yaml
- id: ft-prompt-optimize
  description: "Optimize code review prompt"
  testConfig:
    triggerPaths: ["src/prompts/codeReview/**"]
    llmJudge:
      model: "claude-sonnet-4-20250514"
      testCases:
        - input: "function foo() { return 1 }"
          expectedBehavior: "Should note missing type annotations"
        - input: "const x: string = 'hello'"
          expectedBehavior: "Should pass without issues"
      evaluationCriteria:
        - "Produces actionable feedback"
        - "Catches common anti-patterns"
      passThreshold: 0.8
```

**Feature with LLM evaluation (external reference for large test suites):**
```yaml
- id: ft-agent-refactor
  description: "Refactor code review agent"
  testConfig:
    llmJudge:
      $ref: "./src/agents/codeReview/test.config.json"
```

Where `test.config.json` contains:
```json
{
  "model": "claude-sonnet-4-20250514",
  "testCases": [
    { "input": "...", "expectedBehavior": "..." }
  ],
  "evaluationCriteria": ["..."],
  "passThreshold": 0.8
}
```

**Feature requiring manual verification:**
```yaml
- id: ft-landing-page
  description: "Redesign landing page"
  testConfig:
    manual:
      required: true
      instructions: "Verify layout matches Figma design, test on mobile"
```

**Complex feature (multiple test types):**
```yaml
- id: ft-autonomous-reviewer
  description: "Build autonomous code review agent"
  testConfig:
    triggerPaths: ["src/agents/reviewer/**"]
    additional:
      - "pnpm test:agents:unit"
      - "pnpm test:agents:integration"
    llmJudge:
      $ref: "./src/agents/reviewer/eval.config.json"
    manual:
      required: true
      instructions: "Run against 3 real PRs, verify quality"
```

#### Test Execution Flow

```
Feature Marked Complete
    │
    ▼
┌─────────────────────────────────────────┐
│  1. Run Project Test Command            │
│     pnpm test (always, full suite)      │
└──────────────────┬──────────────────────┘
                   │ PASS
                   ▼
┌─────────────────────────────────────────┐
│  2. Run additional commands (if any)    │
│     e.g., pnpm test:payments:e2e        │
└──────────────────┬──────────────────────┘
                   │ PASS
                   ▼
┌─────────────────────────────────────────┐
│  3. Run LLM judge (if configured)       │
│     Evaluate against test cases         │
└──────────────────┬──────────────────────┘
                   │ PASS (>= threshold)
                   ▼
┌─────────────────────────────────────────┐
│  4. Check manual.required               │
│     If true → return control to human   │
│     If false → continue to Review Agent │
└─────────────────────────────────────────┘
```

Any failure at steps 1-3 → Status = `failing`, return to implementor.

#### Manual Testing Escape Hatch

When `manual.required: true`, the worker exits and returns control:

```typescript
if (feature.testConfig?.manual?.required) {
  await updateStatus(feature.id, { status: 'needs_human_verification' })

  await notify({
    type: 'manual_verification_required',
    priority: 'high',
    featureId: feature.id,
    instructions: feature.testConfig.manual.instructions,
    actions: [
      { label: 'Mark Passing', endpoint: '/verify/pass' },
      { label: 'Mark Failing', endpoint: '/verify/fail' },
    ]
  })

  return { status: 'awaiting_human', featureId: feature.id }
}
```

### UI Testing

UI tests have unique characteristics that don't fit the standard `testCommand` model:
- **10-100x slower** than unit tests
- **Inherently flakier** (timing, animations, network)
- **Visual** (functional correctness ≠ visual correctness)
- **Cross-browser** (may need multiple environments)

Running full E2E on every feature completion destroys iteration speed and budget. The solution is tiered execution.

#### UI Test Configuration

Extend `FeatureTestConfig` with UI-specific options:

```typescript
interface FeatureTestConfig {
  // ...existing fields
  triggerPaths?: string[]
  additional?: string | string[]
  llmJudge?: LlmJudgeConfig
  manual?: ManualConfig

  // UI test configuration
  ui?: UiTestConfig
}

interface UiTestConfig {
  // When to run UI tests for this feature
  runOn: 'feature' | 'milestone' | 'manual'

  // Playwright command (scoped to this feature)
  command?: string  // e.g., "pnpm test:e2e --grep 'auth flow'"

  // Visual regression
  visual?: {
    enabled: boolean
    threshold: number        // 0.01 = 1% pixel diff allowed
    capturePages: string[]   // ["/login", "/dashboard"]
  }

  // AI agent verification (Review Agent uses Playwright MCP)
  agentVerification?: AgentVerificationConfig

  // Flakiness handling
  flakiness?: {
    retries: number           // Default: 2
    retryDelay: number        // ms between retries
    quarantineAfter: number   // Auto-quarantine after N flaky runs
  }
}

interface AgentVerificationConfig {
  enabled: boolean
  scenarios: UserScenario[]
  captureVideo: boolean      // Record for debugging
}

interface UserScenario {
  id: string
  description: string        // "User can log in with valid credentials"
  startUrl: string           // "/login"
  steps: string[]            // Natural language steps
  expectedOutcome: string    // "User sees dashboard with their name"
}
```

#### Layered Verification Model

| Layer | Speed | Who | What |
|-------|-------|-----|------|
| Unit tests | Fast | CI | Code logic correct |
| E2E tests | Slow | CI | User flows work |
| Visual regression | Medium | CI | UI looks right |
| Agent verification | Slow | Review Agent | Feature actually usable |

#### Test Execution Flow (with UI)

```
Feature Marked Complete
    │
    ▼
┌─────────────────────────────────────────┐
│  1. Unit/Integration Tests              │
│     pnpm test (always, fast)            │
└──────────────────┬──────────────────────┘
                   │ PASS
                   ▼
┌─────────────────────────────────────────┐
│  2. Feature-level UI tests              │
│     (only if ui.runOn === 'feature')    │
│     pnpm test:e2e --grep 'feature-id'   │
└──────────────────┬──────────────────────┘
                   │ PASS
                   ▼
┌─────────────────────────────────────────┐
│  3. Visual regression check             │
│     (if ui.visual.enabled)              │
│     Compare screenshots to baseline     │
└──────────────────┬──────────────────────┘
                   │ PASS (within threshold)
                   ▼
┌─────────────────────────────────────────┐
│  4. LLM Judge (if configured)           │
└──────────────────┬──────────────────────┘
                   │ PASS
                   ▼
┌─────────────────────────────────────────┐
│  5. Review Agent                        │
│     (may include Playwright MCP         │
│      agent verification)                │
└─────────────────────────────────────────┘
```

At **milestone boundaries**, run cumulative UI tests:

```
Milestone Features All Passing
    │
    ▼
┌─────────────────────────────────────────┐
│  Milestone UI Test Suite                │
│                                         │
│  • All features with ui.runOn =         │
│    'milestone' run now                  │
│  • Full E2E suite for milestone scope   │
│  • Cross-browser matrix (if configured) │
└─────────────────────────────────────────┘
```

#### Review Agent: Playwright MCP Integration

The Review Agent can use Playwright MCP to verify features from a user perspective:

```typescript
async function performAgentVerification(
  feature: Feature,
  config: AgentVerificationConfig
): Promise<VerificationResult> {
  const browser = await playwrightMcp.launch({
    headless: true,
    video: config.captureVideo
  })

  const results: ScenarioResult[] = []

  for (const scenario of config.scenarios) {
    await browser.navigate(scenario.startUrl)

    // Execute natural language steps via MCP
    for (const step of scenario.steps) {
      const action = await reviewAgent.reasonAboutStep(step, browser.accessibilityTree)
      await browser.execute(action)
    }

    // Verify outcome
    const currentState = await browser.getAccessibilityTree()
    const outcomeVerified = await reviewAgent.verifyOutcome(
      scenario.expectedOutcome,
      currentState
    )

    results.push({
      scenarioId: scenario.id,
      passed: outcomeVerified.passed,
      reasoning: outcomeVerified.reasoning,
      screenshots: await browser.getScreenshots(),
      video: config.captureVideo ? await browser.getVideo() : undefined
    })
  }

  return { scenarios: results }
}
```

#### Self-Healing Selectors

When selectors break, the agent reasons about alternatives:

```typescript
async function executeStep(step: string, tree: AccessibilityTree) {
  const primaryAction = await reasonAboutStep(step, tree)

  try {
    await browser.execute(primaryAction)
  } catch (e) {
    // Self-heal: reason about what changed
    const alternativeAction = await reasonAboutFailedStep(
      step, tree, primaryAction, e
    )
    await browser.execute(alternativeAction)

    // Record the heal for learning
    await appendProgress(taskId, {
      type: 'ui_self_heal',
      originalSelector: primaryAction.selector,
      newSelector: alternativeAction.selector,
      reasoning: alternativeAction.reasoning
    })
  }
}
```

#### UI Test Status Tracking

Track UI-specific state in status.json:

```json
{
  "features": {
    "ft-auth-login": {
      "status": "passing",
      "uiTests": {
        "lastRun": "2024-01-15T14:30:00Z",
        "flakeCount": 2,
        "quarantined": false,
        "lastScreenshots": ["login-page.png", "dashboard.png"],
        "lastVideo": "auth-login-verification.webm"
      }
    }
  }
}
```

#### Example: Login Feature with UI Testing

```yaml
- id: ft-auth-login
  description: "Implement login flow with OAuth"
  dependsOn: [ft-auth-setup]

  testConfig:
    triggerPaths: ["src/app/auth/**", "src/components/LoginForm/**"]
    additional: "pnpm test:auth:unit"

    ui:
      runOn: feature  # Fast feedback - runs per feature
      command: "pnpm test:e2e --grep 'login'"

      visual:
        enabled: true
        threshold: 0.02
        capturePages: ["/login", "/login?error=invalid"]

      flakiness:
        retries: 2
        retryDelay: 1000
        quarantineAfter: 3

      agentVerification:
        enabled: true
        captureVideo: true
        scenarios:
          - id: happy-path
            description: "User logs in with Google OAuth"
            startUrl: "/login"
            steps:
              - "Click the 'Continue with Google' button"
              - "Complete OAuth flow (mock provider)"
              - "Wait for redirect to dashboard"
            expectedOutcome: "User sees dashboard with their profile picture and name"

          - id: error-handling
            description: "User sees error for invalid credentials"
            startUrl: "/login"
            steps:
              - "Enter 'test@example.com' in email field"
              - "Enter 'wrongpassword' in password field"
              - "Click 'Sign in' button"
            expectedOutcome: "Error message appears: 'Invalid credentials'"
```

#### UI Testing Budget Controls

UI testing is expensive. Add budget limits:

```typescript
interface BudgetConfig {
  // ...existing fields
  maxUiTestCostPerFeature: number    // e.g., $0.50
  maxAgentVerificationCost: number   // e.g., $1.00
}
```

When budget is tight, skip agent verification and fall back to deterministic E2E only.

### Decision

A recorded choice made during execution:

```typescript
interface Decision {
  id: string;
  tier: 'trivial' | 'minor' | 'medium' | 'major';
  question: string;
  options: OptionDefinition[];
  chosenOption: string;
  reasoning: string;
  madeBy: 'agent' | 'human' | 'parallel_winner';
  reviewStatus: 'pending' | 'approved' | 'overridden';
  timestamp: number;
  featureId?: string;            // Which feature this decision was for
}
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        NextGen Orchestrator                              │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    Domain Memory Layer                            │   │
│  │                                                                   │   │
│  │  .typedai/memory/{taskId}/                                       │   │
│  │  ├── goals.yaml      (what we want - stable)                     │   │
│  │  ├── status.json     (what's true - test-verified)               │   │
│  │  ├── progress.md     (what happened - append-only)               │   │
│  │  └── context.md      (session context - regenerated)             │   │
│  │                                                                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                    │                                     │
│  ┌────────────────┐  ┌─────────────▼───┐  ┌───────────────────────┐    │
│  │TaskOrchestrator│  │ DecisionManager │  │ NotificationService   │    │
│  │                │  │                 │  │                       │    │
│  │ • Milestone    │  │ • Tier classify │  │ • CLI output          │    │
│  │   progress     │  │ • AI analysis   │  │ • Desktop alerts      │    │
│  │ • Feature      │  │ • Recording     │  │ • Webhooks (Slack)    │    │
│  │   selection    │  │ • Human routing │  │ • WebSocket (UI)      │    │
│  └───────┬────────┘  └────────┬────────┘  └───────────────────────┘    │
│          │                    │                                          │
│  ┌───────▼────────────────────▼─────────┐                               │
│  │           WorkerSession               │                               │
│  │                                       │                               │
│  │  • Session initialization             │                               │
│  │  • Context hydration from memory      │                               │
│  │  • Single-feature focus               │                               │
│  │  • TodoWrite for display              │                               │
│  │  • Test verification on completion    │                               │
│  └───────┬───────────────────────────────┘                               │
│          │                                                               │
│  ┌───────▼──────────────────────────────┐                               │
│  │          ParallelExplorer            │                               │
│  │                                      │                               │
│  │  • Git worktree management           │                               │
│  │  • Dual session execution            │                               │
│  │  • Both work on SAME feature         │                               │
│  │  • Winner selection (AI or human)    │                               │
│  │  • Record approach in progress.md    │                               │
│  └──────────────────────────────────────┘                               │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    Code Discovery System                         │    │
│  │  ┌─────────────────────────┐  ┌──────────────────────────────┐  │    │
│  │  │   Discovery Agent       │  │   Repository Map             │  │    │
│  │  │   (Cerebras LLMs)       │  │                              │  │    │
│  │  │                         │  │  • FileSystemTree            │  │    │
│  │  │  • Iterative selection  │  │  • Folder summaries          │  │    │
│  │  │  • Regex search         │  │  • File summaries            │  │    │
│  │  │  • Vector search        │  │  • Language project map      │  │    │
│  │  │  • Query answering      │  │                              │  │    │
│  │  └────────────┬────────────┘  └──────────────┬───────────────┘  │    │
│  │               │                              │                   │    │
│  │               └──────────────┬───────────────┘                   │    │
│  │                              │                                   │    │
│  │              Available as: CLI | MCP | LLM Tool                  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌──────────────────┐  ┌────────────────────────────────────────┐       │
│  │   AI Reviewer    │  │           Knowledge Base               │       │
│  │                  │  │                                        │       │
│  │ • Test gate      │◄─┤ • Code patterns (do this)              │       │
│  │ • Diff analysis  │  │ • Pitfalls (avoid this)                │       │
│  │ • Pattern check  │  │ • Preferences (project conventions)    │       │
│  │ • Regression     │  │ • Context (architectural decisions)    │       │
│  │   detection      │  │                                        │       │
│  └──────────────────┘  └────────────────────────────────────────┘       │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │                    Git Branching Layer                        │       │
│  │                                                               │       │
│  │  main ─────┬─────────────────────────────────────────────►   │       │
│  │            │                                                  │       │
│  │  task/123 ─┼──┬──────────┬──────────┬─────────────────────►  │       │
│  │               │          │          │                         │       │
│  │  feature/1 ───┴──────────│          │                         │       │
│  │  feature/2 ──────────────┴──────────│                         │       │
│  │  feature/3 ─────────────────────────┴─────────────────────►  │       │
│  │                                                               │       │
│  │  parallel/opt-a ─────────────────► (worktree 1)              │       │
│  │  parallel/opt-b ─────────────────► (worktree 2)              │       │
│  └──────────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility |
|-----------|---------------|
| **Domain Memory** | Persistent state: goals, status, progress, context |
| **TaskOrchestrator** | Milestone/feature progress, next feature selection |
| **DecisionManager** | Decision classification, recording, human routing |
| **WorkerSession** | Context hydration, single-feature execution, test verification |
| **ParallelExplorer** | Worktree creation, dual execution, winner selection |
| **DiscoveryAgent** | File selection, codebase queries (Cerebras LLMs) |
| **RepositoryMap** | FileSystemTree generation with AI summaries |
| **AIReviewer** | Test gate + KB-powered review, regression detection |
| **NotificationService** | Multi-channel notification dispatch |
| **KnowledgeBase** | Pattern storage, retrieval, learning extraction |

---

## Domain Memory System

Domain memory provides persistent, cross-session state that allows agents to resume work with full context.

### File Structure

```
.typedai/memory/{taskId}/
├── goals.yaml      # Hierarchical goals (stable, human-editable)
├── status.json     # Test-verified state (machine-updated)
├── progress.md     # Append-only audit log
└── context.md      # Session context (regenerated)
```

### goals.yaml

Set by the Initializer Agent, rarely changes. Human-editable YAML.

```yaml
task: "Migrate authentication to NextAuth"
description: "Full migration from Express/Passport to Next.js/NextAuth"
createdAt: "2024-01-15T10:00:00Z"

milestones:
  - id: ms-1
    name: "NextAuth Setup"
    description: "Install and configure NextAuth basics"
    requiresHumanReview: false
    subtasks:
      - id: st-1-1
        name: "Install dependencies"
        features:
          - id: ft-1-1-1
            description: "Install NextAuth and required packages"
            testCommand: "pnpm test:auth:deps"
            dependsOn: []
          - id: ft-1-1-2
            description: "Configure environment variables"
            testCommand: "pnpm test:auth:env"
            dependsOn: [ft-1-1-1]
      - id: st-1-2
        name: "Create route handler"
        features:
          - id: ft-1-2-1
            description: "Create [...nextauth].ts API route"
            testCommand: "pnpm test:auth:route"
            dependsOn: [ft-1-1-2]

  - id: ms-2
    name: "Provider Migration"
    description: "Migrate OAuth providers from Passport"
    requiresHumanReview: true
    dependsOn: [ms-1]
    subtasks:
      - id: st-2-1
        name: "Google OAuth"
        features:
          - id: ft-2-1-1
            description: "Configure Google provider"
            testCommand: "pnpm test:auth:google"
            dependsOn: []
```

### status.json

Updated only by test results. Machine-managed.

```json
{
  "taskId": "auth-migration-001",
  "lastUpdated": "2024-01-15T14:30:00Z",
  "features": {
    "ft-1-1-1": {
      "status": "passing",
      "lastTest": "2024-01-15T11:45:23Z",
      "lastTestDuration": 1234,
      "attempts": 1,
      "commits": ["abc1234"]
    },
    "ft-1-1-2": {
      "status": "passing",
      "lastTest": "2024-01-15T12:15:00Z",
      "lastTestDuration": 856,
      "attempts": 1,
      "commits": ["def5678"]
    },
    "ft-1-2-1": {
      "status": "failing",
      "lastTest": "2024-01-15T14:30:00Z",
      "lastTestDuration": 2341,
      "attempts": 2,
      "lastError": "Route handler returns 404",
      "commits": []
    }
  },
  "milestones": {
    "ms-1": {
      "status": "in_progress",
      "passing": 2,
      "total": 3
    },
    "ms-2": {
      "status": "blocked",
      "passing": 0,
      "total": 1
    }
  }
}
```

### progress.md

Append-only audit trail. Each session appends an entry.

```markdown
# Progress Log: auth-migration-001

## 2024-01-15T11:45:23Z - Worker Session

**Feature:** ft-1-1-1 (Install NextAuth and required packages)
**Status:** pending → passing
**Approach:** Added next-auth, @auth/prisma-adapter to package.json
**Test:** `pnpm test:auth:deps` ✓ (1.2s)
**Commits:** abc1234
**Files Changed:** package.json, pnpm-lock.yaml

---

## 2024-01-15T14:30:00Z - Worker Session

**Feature:** ft-1-2-1 (Create [...nextauth].ts API route)
**Status:** pending → failing
**Approach:** Created app/api/auth/[...nextauth]/route.ts with basic config
**Test:** `pnpm test:auth:route` ✗ (2.3s)
**Error:** Route handler returns 404 - file not in correct location
**Commits:** none (reverted)
**Attempt:** 2 of 3
**Notes:** Need to investigate App Router auth setup pattern

---
```

### context.md

Regenerated each session from other files.

```markdown
# Session Context

## Task: Migrate authentication to NextAuth
**Progress:** 2/4 features passing (50%)
**Current Milestone:** ms-1 (NextAuth Setup) - 2/3 passing

## Status Overview
- ✓ ft-1-1-1: Install NextAuth and required packages
- ✓ ft-1-1-2: Configure environment variables
- ✗ ft-1-2-1: Create [...nextauth].ts API route (2 failed attempts)
- ○ ft-2-1-1: Configure Google provider (blocked by ms-1)

## Current Feature
**ID:** ft-1-2-1
**Description:** Create [...nextauth].ts API route
**Test Command:** `pnpm test:auth:route`
**Attempts:** 2 of 3

## Previous Attempts
1. Created app/api/auth/[...nextauth]/route.ts - 404 error
2. Moved to pages/api/auth/[...nextauth].ts - 404 error (wrong router)

## Suggested Approach
Previous attempts failed due to incorrect file location. The project uses App Router.
Check Next.js App Router documentation for correct auth route setup.
Consider: app/api/auth/[...nextauth]/route.ts needs proper exports.

## Relevant Files (from Discovery)
- src/app/layout.tsx (App Router root layout)
- src/lib/auth.ts (existing auth utilities)
- package.json (has next-auth installed)

## Constraints
- Do NOT modify files outside the auth scope
- Run tests before marking complete
- If blocked after 3 attempts, escalate to human
```

### TodoWrite Projection

Claude's TodoWrite is used for real-time display within sessions:

```typescript
function projectToTodoWrite(
  goals: GoalTree,
  status: TaskStatus,
  currentFeature: Feature
): TodoWriteInput['todos'] {
  const todos = [];

  // Show milestone progress
  for (const milestone of goals.milestones) {
    const ms = status.milestones[milestone.id];
    todos.push({
      content: `${milestone.name} (${ms.passing}/${ms.total})`,
      status: ms.status === 'passing' ? 'completed' :
              ms.status === 'in_progress' ? 'in_progress' : 'pending',
      activeForm: `Working on ${milestone.name}`,
    });
  }

  // Show current feature
  const fs = status.features[currentFeature.id];
  todos.push({
    content: currentFeature.description,
    status: fs.status === 'passing' ? 'completed' : 'in_progress',
    activeForm: `Implementing: ${currentFeature.description}`,
  });

  return todos;
}
```

---

## Code Discovery System

The NextGen agent uses a powerful code discovery system for understanding and navigating large codebases. This system is available as a **CLI command**, **MCP tool**, and **LLM function tool**.

### Discovery Agent

The discovery agent (`src/swe/discovery/selectFilesAgentWithSearch.ts`) provides intelligent file selection using **ultra-fast Cerebras LLMs**.

#### Key Features

| Feature | Description |
|---------|-------------|
| **Iterative Selection** | Multi-turn conversation to refine file selection |
| **Regex Search** | Pattern matching for exact content (function names, imports) |
| **Vector Search** | Semantic search using embeddings (concepts, patterns) |
| **Prompt Caching** | Optimized message structure for cache hits |
| **Query Answering** | Answer questions about the codebase with citations |

#### Integration with Domain Memory

Discovery is used at two key points:

1. **Initializer Agent**: Understand codebase to generate appropriate goals.yaml
2. **Session Initialization**: Select relevant files for the current feature

```typescript
// During session initialization
const relevantFiles = await selectFilesAgent(
  currentFeature.description,
  { projectInfo: context.projectInfo }
);

// Include in context.md
context.relevantFiles = relevantFiles;
```

---

## Decision Tier System

Decisions are classified by impact and handled accordingly.

### Tier Definitions

| Tier | Examples | Handling |
|------|----------|----------|
| **Trivial** | Variable naming, formatting | Proceed silently |
| **Minor** | Which utility function to use | Proceed + record for async review |
| **Medium** | State management approach | AI analysis → clear winner or parallel explore |
| **Major** | Database schema changes | Block + ask human |

### Decision Flow

```
Agent Encounters Decision Point
    │
    ▼
┌──────────────────────────────┐
│  Classify Tier               │
│  (DecisionTierClassifier)    │
└─────────────┬────────────────┘
              │
    ┌─────────┼─────────┬─────────────┐
    ▼         ▼         ▼             ▼
 TRIVIAL   MINOR     MEDIUM        MAJOR
    │         │         │             │
    │         │         ▼             │
    │         │    ┌─────────────┐    │
    │         │    │ AI Analysis │    │
    │         │    │             │    │
    │         │    │ Has clear   │    │
    │         │    │ winner?     │    │
    │         │    └──────┬──────┘    │
    │         │       ┌───┴───┐       │
    │         │       ▼       ▼       │
    │         │      YES      NO      │
    │         │       │       │       │
    │         │       │       ▼       │
    │         │       │  ┌─────────┐  │
    │         │       │  │Parallel │  │
    │         │       │  │Explore  │  │
    │         │       │  │(same    │  │
    │         │       │  │feature) │  │
    │         │       │  └────┬────┘  │
    │         │       │       │       │
    │         │       ▼       ▼       │
    │         └──────►Record◄─┘       │
    │                  │              │
    ▼                  ▼              ▼
 Proceed           Proceed        Block
 Silently          + Record       + Ask
                   (async         Human
                    review)
```

---

## Session Model & Initialization

### Two Agent Types

#### Initializer Agent

Runs once per task. Creates the domain memory structure.

**Tools**: Read-only (file_tree, query, grep, discovery)
**Output**: goals.yaml, initial status.json, initial progress.md

```typescript
async function runInitializerAgent(taskDescription: string): Promise<void> {
  // 1. Use discovery to understand codebase
  const codebaseContext = await queryWorkflowWithSearch(
    "What is the overall structure and key technologies of this project?"
  );

  // 2. Generate goals.yaml with milestones/subtasks/features
  const goals = await generateGoals(taskDescription, codebaseContext);

  // 3. Generate testCommands for each feature
  for (const feature of getAllFeatures(goals)) {
    feature.testCommand = await generateTestCommand(feature);
  }

  // 4. Initialize status.json (all pending)
  const status = initializeStatus(goals);

  // 5. Write files
  await saveGoals(taskId, goals);
  await saveStatus(taskId, status);
  await appendProgress(taskId, {
    type: 'initialization',
    goals: goals,
  });
}
```

#### Worker Agent

Runs in a loop. Works on one feature at a time.

**Tools**: Full code tools + TodoWrite
**Input**: context.md (generated from domain memory)
**Output**: Code changes, test results → status.json, progress.md

### Session Initialization (Context Hydration)

Every worker session starts with context hydration:

```typescript
async function initializeWorkerSession(taskId: string): Promise<SessionContext> {
  // 1. Load persistent state
  const goals = await loadGoals(taskId);
  const status = await loadStatus(taskId);
  const progress = await loadRecentProgress(taskId, 5); // Last 5 entries

  // 2. Handle dirty git state
  await handleDirtyState(taskId);

  // 3. Select next feature
  const nextFeature = selectNextFeature(goals, status);
  if (!nextFeature) {
    return { complete: true };
  }

  // 4. Check attempt limit
  const featureStatus = status.features[nextFeature.id];
  if (featureStatus.attempts >= featureStatus.maxAttempts) {
    await escalateToHuman(taskId, nextFeature, 'max_attempts_reached');
    return { blocked: true, reason: 'max_attempts' };
  }

  // 5. Discover relevant files
  const relevantFiles = await selectFilesAgent(nextFeature.description);

  // 6. Get KB learnings
  const learnings = await knowledgeBase.getRelevant(
    nextFeature.description,
    relevantFiles.map(f => f.filePath)
  );

  // 7. Generate context.md
  const context = generateContext({
    goals,
    status,
    progress,
    nextFeature,
    relevantFiles,
    learnings,
  });

  await saveContext(taskId, context);

  // 8. Project to TodoWrite
  const todos = projectToTodoWrite(goals, status, nextFeature);

  return {
    context,
    nextFeature,
    todos,
    relevantFiles,
  };
}
```

### Handling Dirty Git State

Dirty git state can occur in two scenarios:

1. **Parallel exploration abandonment** — Agent started exploring an approach (e.g., complex generic types) but got stuck with non-compiling code
2. **Interrupted session** — Process killed, network failure, etc.

#### Resolution Flow

```
Session Init detects uncommitted changes
    │
    ▼
┌─────────────────────────────────────────┐
│  LLM evaluates dirty changes            │
│                                         │
│  Inputs:                                │
│  • git diff (the changes)               │
│  • Current feature context              │
│  • Last progress.md entry               │
│                                         │
│  Questions:                             │
│  1. Are changes relevant to the task?   │
│  2. Is this good/working code?          │
│  3. Do tests pass with these changes?   │
└──────────────────┬──────────────────────┘
                   │
    ┌──────────────┴──────────────┐
    ▼                             ▼
  KEEP                          STASH
  (relevant + good)             (irrelevant or broken)
    │                             │
    ▼                             ▼
  Commit as WIP               git stash
  Continue work               Notify operator
                              Log in progress.md
```

```typescript
interface DirtyStateEvaluation {
  relevantToTask: boolean
  codeQuality: 'good' | 'partial' | 'broken'
  testsPassing: boolean
  recommendation: 'keep' | 'stash'
  reasoning: string
}

async function handleDirtyState(taskId: string): Promise<void> {
  const diff = await git.diff()
  if (!diff) return  // Clean state

  const context = await loadContext(taskId)
  const lastProgress = await getLastProgressEntry(taskId)

  // LLM evaluates the dirty changes
  const evaluation = await evaluateDirtyChanges({
    diff,
    featureContext: context.currentFeature,
    lastProgress,
  })

  if (evaluation.recommendation === 'keep' && evaluation.testsPassing) {
    await git.commit('WIP: partial progress from previous session')
    await appendProgress(taskId, {
      type: 'dirty_state_recovered',
      action: 'committed',
      reasoning: evaluation.reasoning,
    })
  } else {
    await git.stash(`dirty-state-${Date.now()}`)
    await notify({
      type: 'dirty_state_stashed',
      priority: 'normal',
      message: `Stashed uncommitted changes: ${evaluation.reasoning}`,
      diff: diff.substring(0, 500),  // Preview
    })
    await appendProgress(taskId, {
      type: 'dirty_state_recovered',
      action: 'stashed',
      reasoning: evaluation.reasoning,
    })
  }
}
```

### Feature Selection Algorithm

```typescript
function selectNextFeature(goals: GoalTree, status: TaskStatus): Feature | null {
  for (const milestone of goals.milestones) {
    // Check milestone dependencies
    if (!dependenciesMet(milestone, status)) continue;

    for (const subtask of milestone.subtasks) {
      for (const feature of subtask.features) {
        const fs = status.features[feature.id];

        // Skip passing features
        if (fs.status === 'passing') continue;

        // Skip blocked features
        if (fs.status === 'blocked') continue;

        // Check feature dependencies
        if (!featureDependenciesMet(feature, status)) continue;

        // Return first eligible feature
        return feature;
      }
    }
  }

  return null; // All done or all blocked
}
```

### Dependency Validation

Feature dependencies (`dependsOn`) must form a DAG (Directed Acyclic Graph). Cycles are detected and rejected.

#### Cycle Detection

```typescript
function validateDependencies(goals: GoalTree): ValidationResult {
  const features = getAllFeatures(goals)
  const visited = new Set<string>()
  const inStack = new Set<string>()
  const errors: string[] = []

  function detectCycle(featureId: string, path: string[]): boolean {
    if (inStack.has(featureId)) {
      const cycleStart = path.indexOf(featureId)
      const cycle = [...path.slice(cycleStart), featureId]
      errors.push(`Dependency cycle detected: ${cycle.join(' → ')}`)
      return true
    }

    if (visited.has(featureId)) return false

    visited.add(featureId)
    inStack.add(featureId)

    const feature = features.find(f => f.id === featureId)
    for (const depId of feature?.dependsOn ?? []) {
      if (detectCycle(depId, [...path, featureId])) {
        return true
      }
    }

    inStack.delete(featureId)
    return false
  }

  for (const feature of features) {
    detectCycle(feature.id, [])
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}
```

#### When to Validate

1. **Initializer Agent** — Validate after generating goals.yaml
2. **Human Edits** — Validate when goals.yaml is modified
3. **Runtime** — Validate before `selectNextFeature()` (fast check)

```typescript
// In initializerAgent.ts
const goals = await generateGoals(taskDescription, context)
const validation = validateDependencies(goals)

if (!validation.valid) {
  // Fix cycles before saving
  const fixed = await fixDependencyCycles(goals, validation.errors)
  await saveGoals(taskId, fixed)
} else {
  await saveGoals(taskId, goals)
}
```

#### Error Messages

```
Dependency cycle detected: ft-auth-login → ft-auth-session → ft-auth-token → ft-auth-login

To fix: Remove one dependency to break the cycle. Consider:
- ft-auth-login should not depend on ft-auth-session (remove)
- Or restructure into smaller independent features
```

---

## Parallel Exploration

When a medium decision has no clear winner, explore both options in parallel.

### How It Works

Both options work on the **same feature** in separate git worktrees:

```
Feature: ft-1-2-1 "Create [...nextauth].ts API route"
Decision: "App Router vs Pages Router approach?"
    │
    ├── Worktree 1: parallel/opt-a (App Router approach)
    │   └── Worker session implements feature
    │
    └── Worktree 2: parallel/opt-b (Pages Router approach)
        └── Worker session implements feature
```

### Completion Flow

```
Both Options Complete
    │
    ▼
┌──────────────────────────────────────┐
│  Run Tests for Both                  │
│                                      │
│  Option A: pnpm test:auth:route      │
│  Option B: pnpm test:auth:route      │
└───────────────┬──────────────────────┘
                │
    ┌───────────┴───────────┐
    ▼                       ▼
Both Pass              One/Both Fail
    │                       │
    ▼                       ▼
┌─────────────┐       ┌─────────────┐
│ AI Compares │       │ Use passing │
│ approaches  │       │ option      │
└──────┬──────┘       │ (or retry)  │
       │              └─────────────┘
       ▼
Clear winner? ──YES──► Select winner
       │
       NO
       │
       ▼
Notify human for selection
```

### Recording the Winner

```typescript
async function recordParallelWinner(
  taskId: string,
  featureId: string,
  winner: 'a' | 'b',
  optionA: ParallelResult,
  optionB: ParallelResult
): Promise<void> {
  // Record in decisions
  await recordDecision({
    featureId,
    question: optionA.decision.question,
    options: [optionA.approach, optionB.approach],
    chosenOption: winner === 'a' ? optionA.approach : optionB.approach,
    madeBy: 'parallel_winner',
    reasoning: `Both approaches tested. Winner: ${winner}`,
  });

  // Append to progress.md
  await appendProgress(taskId, {
    featureId,
    type: 'parallel_exploration',
    optionA: { approach: optionA.approach, passed: optionA.testsPassed },
    optionB: { approach: optionB.approach, passed: optionB.testsPassed },
    winner,
  });

  // Merge winner, cleanup loser
  await mergeWinner(winner);
  await cleanupWorktrees();
}
```

---

## AI Review System

The Review Agent is a **separate agent** from the Implementing Agent. This separation ensures objective evaluation and prevents the implementor from marking their own work as complete.

### Key Principle: Preventing Reviewer Oscillation

The reviewer must check its **previous decisions** before requesting changes. This prevents circular design changes where the reviewer keeps flip-flopping between approaches.

```typescript
// Before making a decision, reviewer checks history
const previousReviews = await getReviewHistory(featureId);
const previousDecisions = previousReviews.map(r => r.designDecisions);

// If reviewer is about to request a change that contradicts a previous decision:
if (wouldContradictPrevious(newFeedback, previousDecisions)) {
  // Either: stick with previous decision
  // Or: escalate to human for tiebreaker
  // Do NOT flip-flop
}
```

### Review Process

```
Implementing Agent marks feature "completed"
    │
    ▼
┌────────────────────────────────────────┐
│  1. TEST GATE (mandatory)              │
│     Run feature.testCommand            │
│                                        │
│     ├─► FAIL → Status = failing        │
│     │          Attempt++               │
│     │          Return to implementor   │
│     │          (Skip review)           │
│     │                                  │
│     └─► PASS → Continue to review      │
└──────────────┬─────────────────────────┘
               │
               ▼
┌────────────────────────────────────────┐
│  2. REGRESSION CHECK                   │
│     Run affected tests                 │
│                                        │
│     ├─► Regression detected            │
│     │   Status = failing               │
│     │   Record which tests broke       │
│     │   Return to implementor          │
│     │                                  │
│     └─► No regression → Continue       │
└──────────────┬─────────────────────────┘
               │
               ▼
┌────────────────────────────────────────┐
│  3. SPAWN REVIEW AGENT                 │
│     (Separate agent, fresh session)    │
└──────────────┬─────────────────────────┘
               │
               ▼
┌────────────────────────────────────────┐
│  4. LOAD REVIEW CONTEXT                │
│     • git diff base..HEAD              │
│     • KB learnings for file types      │
│     • PREVIOUS REVIEW DECISIONS        │  ◄── Critical for preventing oscillation
│     • Feature requirements             │
└──────────────┬─────────────────────────┘
               │
               ▼
┌────────────────────────────────────────┐
│  5. REVIEW AGENT EVALUATES             │
│     • Code quality & style             │
│     • Test coverage adequate?          │
│     • Anti-patterns present?           │
│     • Requirements met?                │
│     • CHECK: Does feedback contradict  │
│       any previous reviewer decision?  │
└──────────────┬─────────────────────────┘
               │
               ▼
┌────────────────────────────────────────┐
│  6. DECISION                           │
│                                        │
│  APPROVED                              │
│    → Status = passing                  │
│    → Commit changes                    │
│    → Record approval in reviews.json   │
│                                        │
│  CHANGES_REQUESTED                     │
│    → Record feedback + design decision │
│    → Status = failing                  │
│    → Return to implementor             │
│    → Implementor sees review history   │
│                                        │
│  ESCALATE_TO_HUMAN                     │
│    → Conflicting with previous review  │
│    → Or low confidence                 │
│    → Human makes final call            │
└────────────────────────────────────────┘
```

### Review History (Prevents Oscillation)

Each feature maintains a review history that both the reviewer and implementor can see:

```typescript
interface ReviewHistory {
  featureId: string;
  reviews: ReviewRecord[];
}

interface ReviewRecord {
  reviewId: string;
  timestamp: string;
  attempt: number;                    // Which implementation attempt
  decision: 'approved' | 'changes_requested' | 'escalate_to_human';

  // Design decisions made by this reviewer
  // These are BINDING for future reviews unless human overrides
  designDecisions: DesignDecision[];

  feedback: string;
  issues: ReviewIssue[];
  confidence: number;
}

interface DesignDecision {
  id: string;
  category: 'architecture' | 'pattern' | 'style' | 'testing' | 'naming';
  decision: string;                   // e.g., "Use factory pattern for auth providers"
  reasoning: string;
  alternatives_rejected: string[];    // What we decided NOT to do
}
```

**Example review history preventing oscillation:**

```json
{
  "featureId": "ft-1-2-1",
  "reviews": [
    {
      "attempt": 1,
      "decision": "changes_requested",
      "designDecisions": [
        {
          "id": "dd-001",
          "category": "architecture",
          "decision": "Use App Router pattern with route.ts exports",
          "reasoning": "Project uses Next.js 14 App Router",
          "alternatives_rejected": ["Pages Router pattern"]
        }
      ],
      "feedback": "Need to use App Router exports, not Pages Router"
    },
    {
      "attempt": 2,
      "decision": "approved",
      "designDecisions": [],
      "feedback": "Correctly implements App Router pattern per previous decision"
    }
  ]
}
```

If a future reviewer tried to request "switch to Pages Router", the system would flag this as contradicting `dd-001` and either:
1. Reject the contradictory feedback
2. Escalate to human for override

### Review Result

```typescript
interface ReviewResult {
  decision: 'approved' | 'changes_requested' | 'escalate_to_human';
  confidence: number;
  testsPassed: boolean;               // Must be true to reach review
  regressionDetected: boolean;        // Must be false for approval

  // New: Design decisions made in this review
  designDecisions: DesignDecision[];  // Binding for future reviews

  // Check against previous decisions
  contradictsPrevious: boolean;       // If true, must escalate
  contradictionDetails?: string;

  issues: ReviewIssue[];
  suggestions: string[];
  reasoning: string;
  learningsUsed: Learning[];
}
```

### Implementor Sees Review History

When the implementing agent receives feedback, it also sees all previous reviewer decisions:

```markdown
## Review Feedback for ft-1-2-1 (Attempt 3)

### Previous Reviewer Decisions (BINDING)
1. [dd-001] Architecture: Use App Router pattern with route.ts exports
2. [dd-002] Pattern: Use NextAuth's built-in session handling

### Current Feedback
- Issue: Missing error handling for OAuth callback
- Suggestion: Add try/catch around getServerSession()

### Constraints
You MUST maintain compliance with previous decisions dd-001 and dd-002.
Do NOT change the App Router pattern or session handling approach.
```

---

## Notification System

Multi-channel notifications keep humans informed without requiring constant attention.

### Priority Routing

```typescript
const PRIORITY_CHANNELS: Record<Priority, Channel[]> = {
  low: ['cli'],
  normal: ['cli', 'websocket'],
  high: ['cli', 'desktop', 'websocket'],
  urgent: ['cli', 'desktop', 'webhook', 'websocket'],
};
```

### Notification Types

| Type | Priority | Description |
|------|----------|-------------|
| `task_started` | low | Task execution began |
| `feature_completed` | low | Individual feature passing |
| `feature_failing` | normal | Feature failed (with attempt count) |
| `max_attempts_reached` | high | Feature blocked, needs help |
| `milestone_completed` | normal | Milestone finished |
| `parallel_options_ready` | urgent | Both options done, select one |
| `review_required` | high | Human review needed |
| `task_completed` | normal | Full task finished |

### Action Buttons

```typescript
{
  type: 'milestone_review_required',
  title: 'Milestone Ready for Review',
  message: 'ms-2 (Provider Migration) complete - 3/3 features passing',
  actions: [
    { label: 'Approve', type: 'api', endpoint: '/approve/ms-2' },
    { label: 'Request Changes', type: 'api', endpoint: '/changes/ms-2' },
    { label: 'View Progress', type: 'url', url: '/tasks/123/progress' },
    { label: 'Edit Goals', type: 'url', url: '/tasks/123/goals' }
  ]
}
```

---

## Key Flows

### Complete Task Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Task Execution Flow                              │
│                                                                          │
│  1. TASK INITIALIZATION (Initializer Agent)                             │
│     • Parse task description                                             │
│     • Discovery: Understand codebase (Cerebras)                         │
│     • Generate goals.yaml with milestones/subtasks/features             │
│     • Generate testCommand for each feature                             │
│     • Initialize status.json (all pending)                              │
│     • Create task branch                                                │
│     • Write initial progress.md entry                                   │
│                                                                          │
│  2. WORKER SESSION LOOP (repeat until done)                             │
│     │                                                                    │
│     ├─► SESSION INITIALIZATION                                          │
│     │   • Load goals.yaml, status.json, progress.md                     │
│     │   • Select next failing/pending feature                           │
│     │   • Check attempt limit (escalate if max)                         │
│     │   • Discovery: Select relevant files (Cerebras)                   │
│     │   • Generate context.md                                           │
│     │   • Project to TodoWrite for display                              │
│     │                                                                    │
│     ├─► DECISION CHECK (for implementation approach)                    │
│     │   ├─ Clear approach → Single worker session                       │
│     │   └─ Uncertain (medium decision) → Parallel Explorer              │
│     │       • Both options work on SAME feature                         │
│     │       • AI or human selects winner                                │
│     │       • Record winning approach                                   │
│     │                                                                    │
│     ├─► WORKER EXECUTES                                                 │
│     │   • Agent implements feature                                      │
│     │   • Uses TodoWrite for real-time display                          │
│     │   • Uses discovered files as context                              │
│     │   • Uses KB learnings for guidance                                │
│     │                                                                    │
│     ├─► TEST VERIFICATION (mandatory)                                   │
│     │   • Run feature.testCommand                                       │
│     │   • Update status.json based on result                            │
│     │   • Append to progress.md                                         │
│     │   • If fail: increment attempts, check limit                      │
│     │   • If pass: continue to review                                   │
│     │                                                                    │
│     ├─► AI REVIEW (if tests pass)                                       │
│     │   • Check for regressions                                         │
│     │   • Check code against KB patterns                                │
│     │   • Auto-approve OR request changes OR escalate                   │
│     │                                                                    │
│     └─► MILESTONE CHECK                                                 │
│         • All features in milestone passing?                            │
│         • If requiresHumanReview: notify and wait                       │
│         • Human can: approve, request changes, edit goals.yaml          │
│                                                                          │
│  3. TASK COMPLETION                                                      │
│     • All milestones passing                                            │
│     • Final human review                                                │
│     • Extract learnings to KB                                           │
│     • Create PR                                                         │
│     • Archive domain memory                                             │
└─────────────────────────────────────────────────────────────────────────┘
```

### Async Human Review Flow

```
Milestone Complete (requiresHumanReview: true)
    │
    ▼
┌──────────────────────────────────────┐
│  Notify Human                        │
│  • Desktop notification              │
│  • Slack webhook                     │
│  • Include: progress summary,        │
│    features completed, test results  │
└───────────────┬──────────────────────┘
                │
                ▼
┌──────────────────────────────────────┐
│  Agent Continues on Other Work       │
│  • Next milestone (if deps met)      │
│  • OR waits if blocked               │
└───────────────┬──────────────────────┘
                │
    ┌───────────┴───────────┐
    ▼                       ▼
Human Approves         Human Requests Changes
    │                       │
    ▼                       ▼
Continue to          ┌─────────────────┐
next milestone       │ Human can:      │
                     │ • Add feedback  │
                     │ • Edit goals    │
                     │ • Reset status  │
                     └────────┬────────┘
                              │
                              ▼
                     Re-run affected
                     features
```

---

## Persistence Model

All state is persisted for resumability and audit.

### Directory Structure

```
.typedai/
├── memory/{taskId}/              # Domain Memory
│   ├── goals.yaml                # What we want (stable, human-editable)
│   ├── status.json               # What's verified true (test-bound)
│   ├── progress.md               # What happened (append-only audit)
│   └── context.md                # Session context (regenerated)
│
├── decisions/
│   ├── task-{id}.md              # Human-readable decisions log
│   └── task-{id}.json            # Machine-readable decisions
│
├── learnings/
│   ├── typescript/
│   │   └── learning-{id}.md
│   ├── react/
│   │   └── ...
│   └── ...
│
└── reviews/{taskId}/             # Review History (prevents oscillation)
    ├── feature-{id}.json         # Review history per feature
    │                             # Contains: ReviewRecord[], DesignDecision[]
    └── design-decisions.json     # Aggregated design decisions across features
                                  # Indexed for contradiction checking
```

### Review History Storage

The reviews directory maintains the history that prevents reviewer oscillation:

```typescript
// reviews/{taskId}/feature-{id}.json
interface FeatureReviewHistory {
  featureId: string;
  reviews: ReviewRecord[];

  // Aggregated design decisions from all reviews
  // Used to check for contradictions
  bindingDecisions: DesignDecision[];
}

// reviews/{taskId}/design-decisions.json
interface TaskDesignDecisions {
  taskId: string;
  decisions: DesignDecision[];  // All decisions across all features

  // Index for fast contradiction checking
  byCategory: Record<string, DesignDecision[]>;
  byFeature: Record<string, DesignDecision[]>;
}
```

### Resumability

A task can be resumed from domain memory alone:

```typescript
async function resumeTask(taskId: string): Promise<void> {
  // 1. Load domain memory
  const goals = await loadGoals(taskId);
  const status = await loadStatus(taskId);

  // 2. Verify current state (quick test check)
  const verifiedStatus = await verifyPassingFeatures(status, goals);

  // 3. Find where we left off
  const nextFeature = selectNextFeature(goals, verifiedStatus);

  // 4. Continue worker loop
  await runWorkerLoop(taskId, nextFeature);
}
```

---

## Cost Management

### Budget Structure

```typescript
interface BudgetConfig {
  taskBudget: number;                   // e.g., $50.00
  maxCostPerFeature: number;            // e.g., $3.00
  maxAttemptsPerFeature: number;        // e.g., 3
  maxCostPerParallelOption: number;     // e.g., $2.00
}
```

### Cost Optimization

1. **Cerebras for Discovery**: Ultra-fast, low-cost file selection
2. **Test-Bound Status**: Avoid wasted iterations on already-failing code
3. **Single-Feature Focus**: Smaller context per session
4. **KB Learnings**: Apply past knowledge to reduce iterations
5. **Early Escalation**: Don't waste budget on stuck features

---

## File Structure

```
src/agent/nextgen/
│
├── index.ts                    # Main exports
├── DESIGN.md                   # Original design doc
├── DESIGN_v2.md                # This document
├── MEMORY_DESIGN.md            # Detailed memory design
├── agentSdk.ts                 # Agent SDK V2 wrapper
│
├── memory/                     # Domain Memory System
│   ├── types.ts                # Goal, Status, Progress types
│   ├── store.ts                # YAML/JSON/MD file operations
│   ├── goals.ts                # Goal tree operations
│   ├── status.ts               # Status management
│   ├── progress.ts             # Progress logging
│   ├── context.ts              # Context generation
│   ├── sessionInit.ts          # Context hydration
│   ├── projection.ts           # Goals → TodoWrite
│   ├── testRunner.ts           # Test verification
│   └── index.ts
│
├── orchestrator/
│   ├── initializerAgent.ts     # Creates goals.yaml
│   ├── workerAgent.ts          # Single-feature execution
│   ├── milestone.ts            # Task/Milestone/Subtask/Feature types
│   ├── taskOrchestrator.ts     # Task lifecycle with domain memory
│   ├── taskPlanner.ts          # Delegates to initializer
│   └── index.ts
│
├── subtask/
│   ├── subtaskSession.ts       # Session wrapper with init
│   ├── gitBranching.ts         # Git operations
│   └── index.ts
│
├── decisions/
│   ├── decisionTierClassifier.ts
│   ├── decisionAnalyzer.ts
│   ├── decisionManager.ts
│   └── index.ts
│
├── parallel/
│   ├── gitWorktreeService.ts   # Worktree operations
│   ├── parallelExplorer.ts     # Dual session on same feature
│   └── index.ts
│
├── review/
│   ├── reviewAgent.ts          # Separate review agent (fresh session)
│   ├── reviewHistory.ts        # Load/save review records per feature
│   ├── designDecisions.ts      # Track binding decisions, check contradictions
│   ├── contradictionChecker.ts # Detect if new feedback contradicts previous
│   ├── regressionChecker.ts    # Detect test regressions
│   └── index.ts
│
├── notifications/
│   ├── notificationService.ts
│   └── index.ts
│
├── learning/
│   ├── knowledgeBase.ts
│   ├── learningExtractor.ts
│   └── index.ts
│
└── tools/
    ├── toolLoader.ts
    ├── toolGroups.ts
    └── index.ts

src/swe/                        # Software Engineering Tools (shared)
│
├── discovery/
│   └── selectFilesAgentWithSearch.ts  # Discovery agent (Cerebras)
│
├── summaries/
│   ├── repositoryMap.ts        # FileSystemTree with summaries
│   └── summaryBuilder.ts       # AI-generated summaries
│
└── vector/
    └── core/                   # Vector search infrastructure
```

---

## Summary: Key Differences from v1.0

| Aspect | v1.0 | v2.0 |
|--------|------|------|
| **Hierarchy** | Task → Milestone → Subtask | Task → Milestone → Subtask → **Feature** |
| **Status** | Agent-claimed | **Test-bound** (verified by tests + review) |
| **Persistence** | Session files | **Domain memory** (goals/status/progress/context) |
| **Session Start** | Fresh or forked | **Context hydration** from domain memory |
| **Unit of Work** | Subtask | **Feature** (atomic, testable) |
| **Parallel Exploration** | Works on subtask | Works on **same feature** |
| **Review Agent** | Same agent reviews | **Separate agent** reviews after tests pass |
| **Review History** | None | **Full history** with binding design decisions |
| **Oscillation Prevention** | None | **Contradiction checking** against previous decisions |
| **Attempt Tracking** | Limited | **Full history** in progress.md |
| **Human Review** | At milestones | At milestones + **can edit goals.yaml** |

---

*Document Version: 2.0*
*Last Updated: December 2024*