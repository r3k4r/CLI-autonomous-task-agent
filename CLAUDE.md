# CLAUDE.md

Project conventions for `agentrun`. Read `PLAN.md` for the phased implementation plan.

## What this project is

A CLI that reads a plain **note file** — you just write what you want done, in whatever style — and spawns AI coding agents, one per task, each in its own git worktree. It verifies their output and reports results. It orchestrates agents; it is not itself a model.

## Working rules

- Follow `PLAN.md` phase by phase. Do not skip ahead or build later phases early.
- Before starting a phase, re-read its acceptance criteria. They are the spec.
- After every phase: `bun run typecheck && bun run test && bun run lint` must all pass.
- Commit at the end of each phase. Message format: `phase N: short description`.
- Do not add dependencies outside the pinned stack in `PLAN.md`. Ask first.
- Prefer deleting code over adding flags. If a feature isn't in `PLAN.md`, don't build it.

## Optional phases — hard boundary

**Phases 0–8 are the project. Phases 9 (daemon) and 10 (Telegram) are optional and may never be built.**

- Never build Phase 9 or 10 unless explicitly asked in that session.
- Nothing in `src/core/`, `src/cli/`, `src/git/`, `src/providers/`, or `src/verify/` may import from `src/daemon/` or `src/telegram/`.
- `hono` and `grammy` are optionalDependencies. The project must build, test, and run with both uninstalled.
- The CLI must work fully with no daemon running. Adding the daemon later must not change a single Phase 6 test.

## Note file rules

The forgiving parser is the core feature. Treat it that way.

- A file of plain sentences with no markers and no tags must work perfectly. Tags are a power feature, never a requirement.
- Accepted task styles: plain text, `-`, `*`, `+`, `1.`, `- [ ]`, `TODO:`.
- Indented lines belong to the task above as `details` and are passed to the agent as context.
- Ignored: blank lines, `#` headings, `//` comments, fenced code blocks.
- **When writing completion back, only the one finished line may change.** Every other byte — indentation, blank lines, comments, CRLF, missing trailing newline — must survive untouched. There are tests for this; don't weaken them.
- The parser is line-based on purpose. Do not add a markdown AST library.

## Code style

- TypeScript strict mode, ESM, no `any` (use `unknown` and narrow).
- Named exports only, no default exports.
- Small pure functions in `core/`; side effects at the edges (`cli/`, `providers/`, `git/`).
- Errors: throw typed classes from `src/util/errors.ts`. Never `throw new Error('string')` for anything a user might see.
- No `console.log` in `src/` — use the pino logger. The ink TUI is the only exception.
- Async everywhere; no sync `fs` except in `store.ts` (better-sqlite3 is intentionally synchronous).

## Testing

- vitest. Every module in `core/`, `git/`, `providers/`, and `verify/` has tests.
- **Tests must never make a network call or spawn a real AI agent.** Mock `execa` for provider tests.
- Git tests create a real temp repo in `os.tmpdir()` and clean up after themselves.
- Never write to the developer's actual `.agentrun/` directory during tests.
- The mock provider is the default everywhere. `claude-code` is opt-in only.

## Safety rules — not negotiable

1. **Strip `ANTHROPIC_API_KEY` from spawned agent environments** unless `billing: 'api'` is explicitly set. Child processes inherit env vars, and a leaked key silently turns free subscription runs into per-token billing.
2. **Never auto-resolve a git merge conflict.** Abort, report, keep the branch.
3. **Never run an agent in the base branch's working tree.** Always a worktree.
4. **Never commit `.agentrun/`, config secrets, or any token file.**
5. Agent output is untrusted. An agent claiming success does not mean success — only the verify command decides.
6. *(Phase 9 only)* The daemon binds to `127.0.0.1`. Never `0.0.0.0`.
7. *(Phase 10 only)* The Telegram bot checks the owner id before anything else. Unauthorized users get silence, not an error.

## Commands

```bash
bun install           # install dependencies
bun run dev           # run the CLI from source
bun run build         # build with tsup
bun run test          # vitest
bun run typecheck     # tsc --noEmit
bun run lint          # eslint
```

## Debugging tips

- `agentrun run --dry-run` prints the execution plan without spawning anything. Use it whenever the dependency graph looks wrong.
- `--provider mock` reproduces almost every orchestration bug for free. Reach for it before burning tokens.
- Per-task logs live at `.agentrun/logs/<runId>/<taskId>.log`.
- If worktrees get into a bad state: `agentrun clean`, then `git worktree prune`.
