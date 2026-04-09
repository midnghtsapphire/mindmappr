# Testing Strategy: S.H.I.F.T. Framework + Test Harness

S.H.I.F.T. = Systematically Harden, Inspect, Fix, Test. Combined with the S.H.I.F.T. Behavioral Testing Framework for AI agents (memory, reflection, planning, action, system_reliability).

---

## Current State (Brutal Truth)

| What | Status |
|------|--------|
| Unit tests | NONE |
| Integration tests | NONE |
| E2E tests | NONE |
| Load tests | NONE |
| Smoke test | 1 file — `tests/smoke-test.mjs` |
| CI/CD gate | Smoke test only — syntax check + health endpoint |
| Agent behavioral tests | NONE |
| Connection health checks | NONE — status is cosmetic |

This is why Rex can't actually do anything. Nobody tested whether the tools work end-to-end. The connection panel shows green but the underlying APIs fail. Skills load by name but 404 at runtime.

---

## S.H.I.F.T. Behavioral Testing (5 Dimensions)

Each agent gets scored 1-5 on these dimensions. Passing threshold: 4.

### 1. Memory
- Can the agent recall facts from previous conversations?
- Does nightly consolidation actually update memory files?
- Can the agent find and use stored preferences?

**Test:** Tell Rex a fact → clear session → ask about it → score recall accuracy.

### 2. Reflection
- Does the agent recognize its own failures?
- Can it identify what went wrong in a failed tool execution?
- Does it update its approach after errors?

**Test:** Give Rex a task with a deliberate error (wrong repo name) → verify it self-corrects.

### 3. Planning
- Can the agent break complex tasks into steps?
- Does it identify dependencies between steps?
- Does it estimate which tools are needed?

**Test:** Ask Rex to "set up the daily market analysis pipeline" → score the plan quality.

### 4. Action
- Does the tool actually execute successfully?
- Does the result match what was requested?
- Are errors handled gracefully?

**Test:** Execute each of the 21+ Rex tools with valid inputs → verify real results.

### 5. System Reliability
- Do cron jobs fire on schedule?
- Do background processes survive container restarts?
- Is the database consistent after concurrent writes?

**Test:** Schedule a task, restart the server, verify the task still runs.

---

## Test Harness Architecture

```
tests/
├── smoke-test.mjs              # EXISTING — predeploy gate
├── unit/
│   ├── rex-tools.test.mjs      # Each tool function individually
│   ├── server-routes.test.mjs  # API endpoint responses
│   ├── database.test.mjs       # SQLite operations
│   └── connections.test.mjs    # Connection storage and retrieval
├── integration/
│   ├── tool-execution.test.mjs # Tools with real (mocked) API calls
│   ├── agent-routing.test.mjs  # Message → correct agent → response
│   ├── oauth-flow.test.mjs     # Google OAuth complete flow
│   └── content-studio.test.mjs # Content generation pipeline
├── e2e/
│   ├── login-flow.test.mjs     # Auth → session → API access
│   ├── chat-flow.test.mjs      # Send message → get response → tool execution
│   ├── deploy-flow.test.mjs    # PR list → merge → deploy trigger
│   └── revenue-pipeline.test.mjs # Report → PDF → invoice → delivery
├── behavioral/
│   ├── shift-memory.test.mjs   # Agent memory dimension
│   ├── shift-reflection.test.mjs
│   ├── shift-planning.test.mjs
│   ├── shift-action.test.mjs
│   └── shift-reliability.test.mjs
├── connection-health/
│   ├── github.test.mjs         # Verify GitHub API actually works
│   ├── digitalocean.test.mjs   # Verify DO API actually works
│   ├── google-oauth.test.mjs   # Verify Google OAuth actually works
│   ├── stripe.test.mjs         # Verify Stripe actually works
│   ├── discord.test.mjs        # Verify Discord bot actually works
│   ├── openrouter.test.mjs     # Verify LLM calls actually work
│   └── brave-search.test.mjs   # Verify search actually works
└── fixtures/
    ├── mock-responses/          # Canned API responses for offline testing
    └── test-data/               # Sample inputs for tool tests
```

---

## Test Framework

Use **Node.js built-in test runner** (`node:test`) — no extra dependencies. Already available in Node 20.

```javascript
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
```

For mocking HTTP calls: `node:test` mock capabilities + simple fetch wrapper.

---

## Connection Health Tests (P0 Priority)

These tests verify that connections actually work, not just that tokens are stored.

```javascript
// tests/connection-health/github.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('GitHub Connection Health', () => {
  it('should authenticate with stored PAT', async () => {
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `token ${process.env.GITHUB_PAT}` }
    });
    assert.equal(res.status, 200);
    const user = await res.json();
    assert.ok(user.login, 'GitHub PAT is valid and returns user');
  });

  it('should list repos for MIDNGHTSAPPHIRE', async () => {
    const res = await fetch('https://api.github.com/users/midnghtsapphire/repos', {
      headers: { Authorization: `token ${process.env.GITHUB_PAT}` }
    });
    assert.equal(res.status, 200);
    const repos = await res.json();
    assert.ok(repos.length > 0, 'At least one repo exists');
  });
});
```

Each connection test: authenticate → make simple API call → verify response.

---

## Rex Tool Tests (P0 Priority)

Every tool in rex-tools.mjs gets a test. Two modes:

1. **Mock mode** (CI/offline): Uses canned responses
2. **Live mode** (with env vars): Hits real APIs

```javascript
// tests/unit/rex-tools.test.mjs
describe('Rex Tools', () => {
  describe('github_list_repos', () => {
    it('returns array of repos', async () => {
      const result = await executeTool('github_list_repos', {});
      assert.ok(result.success);
      assert.ok(Array.isArray(result.data || result.repos));
    });
  });

  describe('web_search', () => {
    it('returns search results for a query', async () => {
      const result = await executeTool('web_search', { query: 'test query' });
      assert.ok(result.success);
    });
  });

  describe('create_real_pdf', () => {
    it('creates a PDF file', async () => {
      const result = await executeTool('create_real_pdf', {
        title: 'Test Report',
        sections: [{ heading: 'Section 1', content: 'Test content' }]
      });
      assert.ok(result.success);
      assert.ok(result.filename.endsWith('.pdf'));
    });
  });
});
```

---

## CI Pipeline Enhancement

Current: syntax check + smoke test
Target: syntax + unit + integration + connection health + smoke

```yaml
# .github/workflows/predeploy-smoke-test.yml (enhanced)
jobs:
  test:
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci

      # Syntax
      - run: node --check server.mjs
      - run: node --check rex-tools.mjs
      - run: node --check discord-connector.mjs

      # Unit tests (mock mode)
      - run: node --test tests/unit/*.test.mjs

      # Connection health (only if secrets available)
      - run: node --test tests/connection-health/*.test.mjs
        if: env.GITHUB_PAT != ''
        env:
          GITHUB_PAT: ${{ secrets.GITHUB_PAT }}
          DO_API_TOKEN: ${{ secrets.DO_API_TOKEN }}

      # Smoke test
      - run: npm test
```

---

## Test-Driven Fix Priority

Based on USE_CASES.md, these are the tests that unblock revenue:

### Sprint 1: Fix What's Broken
1. `connection-health/google-oauth.test.mjs` — Prove OAuth works or identify the exact failure point
2. `connection-health/stripe.test.mjs` — Prove Stripe can process payments
3. `unit/rex-tools.test.mjs` — Test every tool, identify which ones actually work
4. `connection-health/*.test.mjs` — Test every connection

### Sprint 2: Wire Revenue Pipeline
5. `integration/content-studio.test.mjs` — Report generation → PDF → delivery
6. `e2e/revenue-pipeline.test.mjs` — Full customer purchase flow
7. `integration/tool-execution.test.mjs` — Tool chaining (search → analyze → generate → deliver)

### Sprint 3: Agent Intelligence
8. `behavioral/shift-*.test.mjs` — All 5 S.H.I.F.T. dimensions for Rex
9. `integration/agent-routing.test.mjs` — Multi-agent delegation
10. `e2e/chat-flow.test.mjs` — Full conversation with tool execution

---

## Wizard of Oz Testing Protocol

For testing agent behavior before full automation:

1. **Build WoZ system prompt** — Tell the agent exactly what scenario to expect
2. **Build evaluator prompt** — Separate LLM call scores the agent's response
3. **Evaluate all 5 dimensions** — Score 1-5, passing = 4+
4. **Log DARE entry** — Document what was tested, what passed, what failed
5. **Self-healing retry** — If score < 4, feed critique back to agent, retry (max 3)

---

## Running Tests

```bash
# All tests
node --test tests/**/*.test.mjs

# Just unit tests
node --test tests/unit/*.test.mjs

# Just connection health
node --test tests/connection-health/*.test.mjs

# Just behavioral
node --test tests/behavioral/*.test.mjs

# Smoke only (current)
npm test
```

---

## Metrics to Track

| Metric | Target |
|--------|--------|
| Unit test coverage | 80% of rex-tools functions |
| Connection health pass rate | 100% for configured services |
| S.H.I.F.T. dimension scores | 4+ on all 5 for Rex |
| CI pipeline duration | < 5 minutes |
| Smoke test reliability | 100% pass on green deploys |
