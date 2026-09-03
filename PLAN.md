# agentrun — Implementation Plan

A CLI that reads a plain **note file** where you just write down what you want done, then spawns AI coding agents (one per task) in isolated git worktrees, verifies their work, and reports results.

**This is an orchestrator, not a model.** It never talks to an LLM directly except through a provider adapter.

The project is **complete and fully usable at the end of Phase 8**. Phases 9 and 10 add remote control and are explicitly optional — see the boundary marker below.

---

## How to work through this plan

Read this section before writing any code.

1. Work **one phase at a time, in order**. Do not start Phase N+1 until Phase N's acceptance criteria all pass.
2. After each phase: run `bun run typecheck`, `bun run test`, `bun run lint`. All must pass.
3. Commit at the end of each phase with the message `phase N: <short description>`.
4. Every phase has tests. Write them. A phase without passing tests is not done.
5. If a decision isn't specified here, pick the **simplest thing that works** and leave a `// NOTE:` comment explaining the choice. Do not invent extra features.
6. Stop and ask before adding any dependency not listed in the stack below.
7. **Do not build Phases 9–10 unless explicitly asked.** Nothing in Phases 0–8 may import from `src/daemon/` or `src/telegram/`.

---

## Tech stack (pinned — do not substitute)

| Concern | Choice | Needed by |
|---|---|---|
| Runtime | Node 20+ | core |
| Language | TypeScript, strict mode, ESM | core |
| Package manager | bun | core |
| Build | tsup | core |
| CLI framework | commander | core |
| Terminal UI | ink | Phase 6 |
| Child processes | execa | core |
| State | better-sqlite3 | core |
| Validation | zod | core |
| Logging | pino | core |
| HTTP server | hono | **optional**, Phase 9 |
| Telegram | grammy | **optional**, Phase 10 |
| Tests | vitest | core |

Install `hono` and `grammy` as **optionalDependencies**. The core must build and run with them absent.

**Explicitly forbidden** (do not add these, they are premature):
Redis, BullMQ, Docker, Prisma, any ORM, any web framework other than hono, any git wrapper library (call `git` directly through execa), any markdown AST library (the parser is line-based on purpose).

---

## The note file — the heart of the design

The whole point is that **you open a text file and just write what you want done.** No syntax to remember. The parser must be forgiving.

### What counts as a task

All of these are one task each. The parser accepts every style, mixed freely in the same file:

```
Create a login page
- Create a login page
* Create a login page
+ Create a login page
1. Create a login page
- [ ] Create a login page
TODO: Create a login page
```

Leading and trailing whitespace is trimmed. The list marker, number, or `TODO:` prefix is stripped from the title.

### What is ignored

- Blank lines
- Lines starting with `#` (headings and comments)
- Lines starting with `//`
- Anything inside a fenced code block (` ``` ` or `~~~`)
- Lines under 3 characters after stripping markers

### Continuation lines give the agent context

An **indented** line (2+ spaces or a tab) belongs to the task above it and becomes part of `details`. This is what makes the file feel like real notes:

```
Create a login page
  use the existing Button component from src/ui
  redirect to /dashboard on success
  don't add a "remember me" checkbox

Fix the auth bug
  the session token isn't refreshing after 15 minutes
```

`details` are passed to the agent as extra context. They are not tasks.

### Optional tags

Tags can appear anywhere on a task line and are stripped from the title:

| Tag | Meaning |
|---|---|
| `#id:login` | explicit id (otherwise the title is slugified) |
| `#needs:login` or `#needs:a,b` | dependencies |
| `#model:opus` | model hint for the provider |
| `#skip` | parse it but never run it |
| `#done` | already complete |

Tags are a power feature. A file with zero tags must work perfectly.

### Completion is written back in the file's own style

When a task finishes, the note file is updated in place:

- A line written as `- [ ] Foo` becomes `- [x] Foo`
- Any other style gets ` #done` appended: `Create a login page #done`

Both re-parse as complete, so the file survives round trips. Config option `writeBack: 'auto' | 'none'` — `'none'` leaves the file untouched and keeps state only in the database.

**Rewriting rule:** only the single completed line may change. Every other byte of the file — blank lines, indentation, comments, line endings — must be preserved exactly. Test this.

---

## Core types (implement exactly this shape in `src/core/types.ts`)

```ts
export type TaskStatus =
  | 'pending'    // not started
  | 'blocked'    // a dependency failed, will never run
  | 'running'    // an agent is working on it
  | 'verifying'  // agent finished, running checks
  | 'done'       // verified successfully
  | 'failed'     // agent or verification failed
  | 'skipped'    // #skip tag
  | 'cancelled';

export type LineStyle = 'checkbox' | 'bullet' | 'numbered' | 'todo' | 'plain';

export interface Task {
  id: string;
  title: string;           // markers and tags stripped
  details: string[];       // indented continuation lines
  status: TaskStatus;
  dependsOn: string[];
  model?: string;
  attempts: number;
  maxAttempts: number;     // default 2
  branch?: string;         // agent/<id>
  worktreePath?: string;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  lineNumber: number;      // 0-indexed line in the note file
  lineStyle: LineStyle;    // how to write completion back
}

export interface RunConfig {
  projectPath: string;
  noteFile: string;        // default 'tasks.md'
  provider: string;        // 'mock' | 'claude-code'
  parallel: number;        // default 1
  maxAttempts: number;     // default 2
  writeBack: 'auto' | 'none';
  verifyCommand?: string;  // e.g. 'pnpm test'
  buildCommand?: string;
  baseBranch: string;      // default 'main'
}
```

---

## Phases

### Phase 0 — Scaffold

**Goal:** an empty but working project.

- `bun init`, TypeScript strict + ESM, tsup config, vitest config, eslint + prettier.
- `package.json` scripts: `dev`, `build`, `test`, `typecheck`, `lint`.
- `bin` entry pointing at the built CLI.
- `src/cli/index.ts` registers a single `agentrun --version` command.
- `src/util/logger.ts` exporting a configured pino instance.
- `src/util/errors.ts` with typed error classes.

**Acceptance:**
- `bun run build` produces a working binary.
- `agentrun --version` prints the version.
- `bun run typecheck` and `bun run lint` pass with zero errors.

---

### Phase 1 — Note parser

**Goal:** turn a free-form note file into `Task[]`, and write completion back without disturbing anything else. This is the feature the whole project is named for — get it right.

Implement in `src/core/parser.ts`, line-based, no markdown library:

```ts
parseNotes(content: string): Task[]
markComplete(content: string, lineNumber: number, style: LineStyle): string
addTask(content: string, title: string): string   // appends in the file's dominant style
detectStyle(line: string): LineStyle
```

**Acceptance (write all of these tests):**

Parsing:
- Each of the seven line styles above parses to one task with a clean title.
- A file of nothing but plain sentences, no markers and no tags, parses correctly.
- Indented lines attach to the preceding task as `details` and never become tasks.
- An indented line with no task above it is ignored, not crashed on.
- Headings (`#`), comments (`//`), and blank lines are ignored.
- A task-looking line inside a fenced code block is **not** parsed.
- Tags are extracted and stripped from the title; a tag in the middle of a sentence works.
- `#needs:a,b` and two separate `#needs:` tags both produce `['a','b']`.
- Duplicate slugified ids get unique numeric suffixes.
- `- [x]` and `#done` both yield `status: 'done'`.
- `#skip` yields `status: 'skipped'`.

Writing back:
- `- [ ] Foo` → `- [x] Foo`; every other line in the file is byte-identical.
- `Foo` → `Foo #done`; every other line byte-identical.
- CRLF files stay CRLF. Files without a trailing newline don't gain one.
- Round trip: parse → markComplete → parse gives the expected status.
- `addTask` on an empty file, a bullet-style file, and a plain-text file each append in a sensible style.

---

### Phase 2 — State store

**Goal:** persist run state so `agentrun status` works from another terminal and a crash doesn't lose everything.

Implement in `src/core/store.ts` using better-sqlite3 at `.agentrun/state.db`:
- Tables: `runs`, `tasks`, `events`.
- `createRun(config, tasks)`, `getRun(id)`, `getActiveRun()`, `updateTask(id, patch)`, `appendEvent(taskId, type, message)`, `listTasks(runId)`.
- All writes synchronous. Enable WAL mode.
- Agent output goes to files, not the DB: `.agentrun/logs/<runId>/<taskId>.log`.

**Acceptance:**
- Tests use a temp directory, never the real `.agentrun`.
- State survives closing and reopening the DB.
- Concurrent writers do not corrupt state (hammer `updateTask` in a loop from multiple handles).
- `.agentrun/` is added to `.gitignore` by `agentrun init`.

---

### Phase 3 — Git worktree manager

**Goal:** give every agent its own isolated checkout so they can't overwrite each other.

Implement in `src/git/worktree.ts` by calling `git` via execa:
- `createWorktree(repo, taskId, baseBranch)` → `git worktree add <path> -b agent/<taskId> <baseBranch>`, returns `{ path, branch }`. Worktrees live in `.agentrun/worktrees/<taskId>`.
- `removeWorktree(repo, taskId)` → `git worktree remove --force`, then delete the branch if it has no commits.
- `listWorktrees(repo)`
- `hasChanges(worktreePath)` → true if `git status --porcelain` is non-empty.
- `commitAll(worktreePath, message)`
- `pruneStale(repo)` → `git worktree prune`, plus removes `agent/*` worktrees not in the current run.

**Guards (throw typed errors, and test each one):**
- Refuse if the repo has uncommitted changes on the base branch.
- Refuse if it isn't a git repository.
- Refuse if branch `agent/<taskId>` already exists.
- Never operate on the base branch's working tree.

**Acceptance:**
- Tests create a real temp git repo. Writing a file in worktree A does not appear in worktree B or the base checkout.
- Cleanup leaves no stray worktrees or branches.

---

### Phase 4 — Provider interface + mock provider

**Goal:** define the boundary between the orchestrator and any AI agent, then build a free fake one.

`src/providers/types.ts`:

```ts
export interface AgentContext {
  task: Task;                          // includes details[]
  worktreePath: string;
  model?: string;
  previousError?: string;              // set on retries
  signal: AbortSignal;                 // for `agentrun stop`
  onOutput: (chunk: string) => void;   // streamed to the log file
}

export interface AgentResult {
  success: boolean;
  summary: string;
  error?: string;
  tokensUsed?: { input: number; output: number };
  costUsd?: number;
}

export interface Provider {
  readonly name: string;
  run(ctx: AgentContext): Promise<AgentResult>;
}
```

`src/providers/mock.ts`:
- Sleeps (default 1500ms), writes `<taskId>.txt` into the worktree, returns success.
- `MOCK_FAIL_TASKS` env var (comma-separated ids) makes those tasks fail, so retry logic is testable.
- Respects `signal` and aborts promptly.

**Acceptance:**
- A provider registry maps a name string to an implementation.
- Mock provider tests cover success, failure, and abort.

---

### Phase 5 — Orchestrator

**Goal:** the scheduling loop. This is the heart of the project.

Implement `src/core/orchestrator.ts`:

```ts
class Orchestrator {
  constructor(config: RunConfig, store: Store, provider: Provider);
  start(): Promise<RunSummary>;
  stop(): Promise<void>;
  on(event: 'taskStart'|'taskEnd'|'taskLog'|'runEnd', handler): void;
}
```

Loop behaviour:
1. Build a dependency graph. **Detect cycles and fail fast, naming the cycle.**
2. A task is runnable when all `dependsOn` are `done`. If any dependency `failed`, mark it `blocked` and never run it.
3. Run at most `config.parallel` tasks at once.
4. Per task: create worktree → `running` → call provider → stream output to log → verify (stub as always-pass until Phase 8) → commit → `done` or `failed`.
5. On failure, if `attempts < maxAttempts`, requeue with `previousError` set.
6. On `stop()`, abort running agents, mark them `cancelled`, clean up worktrees.
7. On `done`, call `markComplete` to update the note file (unless `writeBack: 'none'`).

**Acceptance (mock provider only — these tests must cost nothing):**
- 5 independent tasks with `parallel: 3` → never more than 3 running, all finish.
- `a → b → c` runs strictly in order.
- If `a` fails permanently, `b` (needs `a`) ends `blocked`, not `running`.
- A failing task retries exactly `maxAttempts` times, then stops.
- A cyclic dependency errors before any agent starts.
- `stop()` mid-run leaves no orphan processes and no leftover worktrees.
- A completed task's line is updated in the note file; the rest of the file is unchanged.

---

### Phase 6 — CLI

**Goal:** a usable terminal interface. Calls the orchestrator directly — **no daemon, no HTTP**.

| Command | Behaviour |
|---|---|
| `agentrun init` | creates the note file, `agentrun.config.json`, adds `.agentrun/` to `.gitignore` |
| `agentrun add "<title>"` | appends a task in the file's dominant style |
| `agentrun list` | prints parsed tasks, statuses, and dependencies |
| `agentrun run [--parallel N] [--provider mock] [--dry-run]` | starts a run |
| `agentrun status` | current run state (reads SQLite, works from any terminal) |
| `agentrun logs <taskId> [--follow]` | prints a task's log |
| `agentrun retry <taskId>` | resets a failed task and runs it |
| `agentrun stop` | stops the active run |
| `agentrun clean` | prunes worktrees and branches from finished runs |

- `--dry-run` prints the execution plan (order, parallel groups, dependencies) and exits without spawning anything. Build this early — it's the fastest way to debug the graph.
- `run` renders a live ink table. Fall back to plain line output when not a TTY or when `--no-tui` is passed.

**Acceptance:**
- Every command has a test against a temp repo with the mock provider.
- `--dry-run` never creates a worktree or spawns a process.
- Non-TTY output has no ANSI escape codes.
- `agentrun status` works while a run is in progress in another terminal.

---

### Phase 7 — Claude Code provider

**Goal:** replace the mock with a real agent.

Implement `src/providers/claudeCode.ts`:
- Spawns `claude` in headless mode with `cwd` set to the task's worktree.
- Builds the prompt from `task.title`, `task.details`, and `previousError` when retrying.
- Streams stdout/stderr into `ctx.onOutput`.
- Maps exit code and output into an `AgentResult`.

**Critical — subscription billing safety:**

```ts
const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;   // force Pro/Max subscription auth
```

Child processes inherit the parent environment. A leaked `ANTHROPIC_API_KEY` silently converts free subscription runs into per-token billing. Strip it unless `config.billing === 'api'`, which must be an explicit opt-in in `agentrun.config.json`.

Also:
- Keep `mock` as the default provider so tests never change.
- Per-task timeout (default 15 minutes) that aborts a stuck agent.
- Log the exact spawned command for debuggability.

**Acceptance:**
- Unit tests mock `execa`. No test may ever spawn a real agent.
- A test asserts `ANTHROPIC_API_KEY` is absent from the child env by default, and present when `billing: 'api'`.
- A test asserts `task.details` appear in the generated prompt.
- Manual smoke test documented in the README, not automated.

---

### Phase 8 — Verification and merge

**Goal:** stop trusting the agent's own claim of success.

`src/verify/verify.ts`:
- Runs `buildCommand` then `verifyCommand` inside the worktree.
- Captures output into the task log.
- Returns `{ passed, output }`. Non-zero exit means failed, whatever the agent said.
- With no `verifyCommand` configured, mark `done` with `unverified: true`, surfaced in `status`.

`src/git/merge.ts`:
- `agentrun merge [taskId]` merges one agent branch into the base branch.
- Merge **one at a time**, verifying after each.
- On conflict: abort, mark the task `failed` with a clear message, keep the branch. **Never auto-resolve.**
- Stop after the first failure; report which branches remain unmerged.

**Acceptance:**
- A task whose agent "succeeds" but whose tests fail ends `failed`.
- Two branches touching the same line produce a clean abort, not a broken base branch.
- The base branch is never left conflicted.

---

## ✅ The project is complete here

Everything below is optional. Phases 0–8 give you a working tool: write notes, run `agentrun run`, get verified code on branches. Do not start Phase 9 unless you actually want remote control.

---

### Phase 9 — Daemon and HTTP API *(optional)*

**Goal:** separate the engine from the interface so something other than a terminal can drive it.

Only needed if you want Phase 10, a web UI, or to trigger runs from another machine. **A local terminal does not need this.**

Implement `src/daemon/server.ts` with hono:

| Method | Route |
|---|---|
| POST | `/tasks` |
| GET | `/tasks` |
| POST | `/run` |
| POST | `/stop` |
| GET | `/status` |
| GET | `/logs/:taskId` (SSE stream) |
| POST | `/retry/:taskId` |
| POST | `/merge/:taskId` |

- Bind to `127.0.0.1` only. Never `0.0.0.0`.
- Bearer token from `.agentrun/token`, generated on first start, chmod 600.
- `agentrun daemon start|stop|status`.
- `src/daemon/client.ts` wraps these calls. CLI commands use the client **only when a daemon is running**, and otherwise run in-process exactly as before.

**Acceptance:**
- Every route tested with hono's test client.
- Requests without a valid token get 401.
- A test asserts the listener is bound to loopback.
- **All Phase 6 CLI tests still pass unchanged with no daemon running.**
- The core still builds and runs with `hono` uninstalled.

---

### Phase 10 — Telegram bot *(optional, safe to skip forever)*

**Goal:** control runs from a phone.

Depends on Phase 9. Lives entirely in `src/telegram/`. Nothing else in the codebase may import it.

Implement with grammy using **long polling** — no webhook, no public URL, no open port. Works behind a home router.

**Security first — write this before any command:**

```ts
const OWNER_ID = Number(process.env.TELEGRAM_OWNER_ID);
bot.use((ctx, next) => {
  if (ctx.from?.id !== OWNER_ID) return;  // silent ignore, no reply
  return next();
});
```

This bot can execute arbitrary code on the host machine. Unauthorized users get no response at all — an error message would confirm the bot exists.

Commands: `/status`, `/run`, `/stop`, `/add <text>`, `/logs <id>`, `/retry <id>`, `/merge <id>`.

Behaviour:
- `/status` sends one message and then **edits that same message** as tasks progress. Never one message per update.
- Rate-limit edits to at most one every 3 seconds.
- Inline keyboard buttons for Retry / Stop / Merge.
- On failure, send the last 20 lines of the log, truncated to Telegram's limit.
- The bot is a client of the HTTP API only. It must not import the orchestrator.

**Acceptance:**
- Tests stub the grammy context. No real Telegram connection in tests.
- A non-owner user id produces zero API calls.
- `agentrun bot` exits cleanly with a warning when `TELEGRAM_BOT_TOKEN` is missing.
- The core still builds and runs with `grammy` uninstalled.

---

## Non-goals (do not build these)

- A web dashboard
- Multi-user support or accounts
- A manager agent that infers dependencies automatically — dependencies are declared by hand with `#needs:`
- Provider adapters beyond `mock` and `claude-code`
- Distributed execution across machines
- Automatic merge conflict resolution
- Any markdown feature beyond the line formats listed above

---

## Definition of done (Phases 0–8)

- `agentrun init` in a fresh repo, write three plain sentences into the note file, `agentrun run --provider mock` completes all three and marks them done in the file.
- Adding `#needs:` to one of them changes the execution order, visible in `--dry-run`.
- Indented detail lines under a task reach the agent's prompt.
- The same run with `--provider claude-code` produces real commits on real `agent/*` branches.
- `agentrun status` works from a second terminal during a run.
- `bun run test` passes with no network access and no LLM calls.
- README documents install, config, the note file format, and the manual smoke test.
