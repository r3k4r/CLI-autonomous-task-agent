# agentrun

Write what you want done in a plain text file. `agentrun` reads it, spawns an AI coding
agent per task in its own git worktree, verifies the result, and reports back.

It orchestrates agents. It is not itself a model.

## Install

```bash
bun install
bun run build
```

The CLI runs on Node 20+. Bun is the package manager and script runner; the built
binary itself runs under Node, because `better-sqlite3` is a native addon Bun cannot
load ([oven-sh/bun#4290](https://github.com/oven-sh/bun/issues/4290)).

## Quick start

```bash
cd your-project
agentrun init                       # creates tasks.md, config, gitignores .agentrun/
$EDITOR tasks.md                    # write what you want done
agentrun run --dry-run              # see the execution plan, spawn nothing
agentrun run --provider mock        # rehearse for free
agentrun run --provider claude-code # do it for real
```

## The note file

Open it and write. There is no syntax to remember — every one of these is one task,
and you can mix them freely in the same file:

```
Create a login page
- Create a login page
* Create a login page
+ Create a login page
1. Create a login page
- [ ] Create a login page
TODO: Create a login page
```

**Indented lines** below a task become context passed to the agent:

```
Create a login page
  use the existing Button component from src/ui
  redirect to /dashboard on success
  don't add a "remember me" checkbox
```

Blank lines, `#` headings, `//` comments and fenced code blocks are ignored.

### Optional tags

Tags can go anywhere on a line and are stripped from the title. **A file with no tags
at all works perfectly** — these are a power feature, not a requirement.

| Tag                            | Meaning                                        |
| ------------------------------ | ---------------------------------------------- |
| `#id:login`                    | explicit id (otherwise the title is slugified) |
| `#needs:login` or `#needs:a,b` | run only after those tasks succeed             |
| `#model:opus`                  | model hint for the provider                    |
| `#skip`                        | parse it but never run it                      |
| `#done`                        | already complete                               |

### Completion is written back in your own style

When a task finishes, its line is updated in place: `- [ ] Foo` becomes `- [x] Foo`,
and any other style gets ` #done` appended. **Only that one line changes** — your
blank lines, indentation, comments and line endings are preserved byte for byte. Set
`writeBack: "none"` to leave the file alone entirely.

## Commands

| Command                   | What it does                                            |
| ------------------------- | ------------------------------------------------------- |
| `agentrun init`           | create the note file and config, gitignore `.agentrun/` |
| `agentrun add "<title>"`  | append a task in the file's dominant style              |
| `agentrun list`           | print tasks, statuses and dependencies                  |
| `agentrun run`            | run the tasks                                           |
| `agentrun status`         | current run state — works from any terminal             |
| `agentrun logs <taskId>`  | print a task's log                                      |
| `agentrun retry <taskId>` | reset a failed task and run it again                    |
| `agentrun stop`           | stop the active run                                     |
| `agentrun merge [taskId]` | merge agent branches into the base branch               |
| `agentrun clean`          | prune worktrees and branches from finished runs         |

`run` takes `--parallel N`, `--provider <name>`, `--dry-run`, `--no-tui` and
`--no-color`.

## Configuration

`agentrun.config.json`, all fields optional:

```json
{
  "noteFile": "tasks.md",
  "provider": "mock",
  "parallel": 1,
  "maxAttempts": 2,
  "writeBack": "auto",
  "baseBranch": "main",
  "verifyCommand": "bun run test",
  "buildCommand": "bun run build",
  "billing": "subscription",
  "timeoutMs": 900000
}
```

### `billing` — read this before using `claude-code`

`billing` defaults to `"subscription"`, which **strips `ANTHROPIC_API_KEY` from the
spawned agent's environment** so runs go through your Pro/Max subscription. Child
processes inherit the parent environment, and a stray API key silently converts free
subscription runs into per-token billing. Setting `"billing": "api"` keeps the key and
opts into per-token charges — it has to be deliberate.

## How a task runs

1. A worktree is created at `.agentrun/worktrees/<taskId>` on branch `agent/<taskId>`.
2. The agent runs there, so agents can never overwrite each other, and never touch
   your base branch's working tree.
3. Its output streams to `.agentrun/logs/<runId>/<taskId>.log`.
4. `buildCommand` then `verifyCommand` run in the worktree. **An agent claiming success
   proves nothing — only the verify command decides.** With no `verifyCommand`
   configured, the task is marked done but reported as unverified.
5. On success the work is committed to the agent branch and the worktree is removed.
   The branch stays for you to review and merge.

A failed task retries up to `maxAttempts`, with the previous error included in the
retry prompt. Anything depending on a permanently failed task is marked `blocked` and
never runs.

## Merging

```bash
agentrun merge            # every completed task, one at a time
agentrun merge login      # just that one
```

Branches are merged **one at a time**, re-running the verify command after each so a
merge that breaks the base branch is caught immediately and rolled back.

On a conflict the merge is aborted, the branch is kept, and the task is marked failed.
**Conflicts are never resolved automatically**, and the base branch is never left in a
conflicted state. Merging stops at the first failure and tells you which branches were
not attempted, so one bad merge cannot cascade.

## Manual smoke test

Automated tests never spawn a real agent. To check the `claude-code` provider end to
end by hand:

```bash
# 1. In a scratch git repo with at least one commit:
mkdir /tmp/agentrun-smoke && cd /tmp/agentrun-smoke
git init && git commit --allow-empty -m init

# 2. Set up and write one small, real task:
agentrun init
cat > tasks.md <<'EOF'
Add a hello.txt file containing a friendly greeting
  keep it to a single line
EOF

# 3. Confirm the plan first — this spawns nothing:
agentrun run --dry-run

# 4. Run it for real:
agentrun run --provider claude-code

# 5. Check the results:
agentrun status
git log agent/add-a-hello-txt-file-containing-a-friendly-greeting --stat
cat tasks.md          # the line should now end in #done
```

Expected: one `agent/*` branch with a real commit, the task marked `done` in both
`status` and `tasks.md`, and a log under `.agentrun/logs/`. Verify the API key was not
used by checking your Anthropic console shows no new API spend.

Clean up with `agentrun clean`.

## Development

```bash
bun install
bun run dev       # run the CLI from source
bun run build     # build with tsup
bun run test      # vitest — no network, no LLM calls, costs nothing
bun run typecheck
bun run lint
```

Tests use the mock provider throughout, mock `execa` for provider tests, and create
real temp git repositories that they clean up after themselves.

## Troubleshooting

- **The dependency graph looks wrong** — `agentrun run --dry-run` prints the execution
  plan without spawning anything.
- **Reproducing an orchestration bug** — `--provider mock` reproduces almost all of
  them for free.
- **Worktrees in a bad state** — `agentrun clean`, then `git worktree prune`.
- **A run refuses to start** — commit or stash changes to tracked files first. Agents
  branch from a committed state, so uncommitted work would be invisible to them.
