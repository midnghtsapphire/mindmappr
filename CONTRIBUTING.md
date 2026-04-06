# Contributing to MindMappr

Thank you for contributing! Please follow these guidelines to keep our codebase clean, our history intact, and our team's work safe.

---

## Branching Strategy

We use a **feature-branch workflow**. All work happens on short-lived feature branches that are merged into `master` via Pull Requests. **Never push directly to `master`.**

### Branch Naming

| Prefix | Use case | Example |
|---|---|---|
| `feature/` | New features or enhancements | `feature/discord-skills-predeploy` |
| `fix/` | Bug fixes | `fix/sqlite-ephemeral-storage` |
| `chore/` | Maintenance, config, dependencies | `chore/update-node-20` |
| `docs/` | Documentation only | `docs/update-raid-log` |
| `hotfix/` | Urgent production fix | `hotfix/openrouter-timeout` |

### Workflow

```
master
  └── feature/my-feature    ← branch off master
        ├── commit ...
        ├── commit ...
        └── PR → master     ← merge via Pull Request only
```

1. **Branch off `master`:**
   ```bash
   git checkout master && git pull
   git checkout -b feature/your-feature-name
   ```

2. **Make small, descriptive commits:**
   ```
   feat: add stripe invoice tool
   fix: handle missing discord token gracefully
   ```

3. **Keep your branch up to date** by rebasing (not merging) `master` into your feature branch:
   ```bash
   git fetch origin
   git rebase origin/master
   ```

4. **Open a Pull Request** when your feature is ready. Include a brief description of what changed and why.

5. **Never force-push to `master`.** If you need to clean up your feature branch history, rebase and force-push *your own branch* only:
   ```bash
   git push --force-with-lease origin feature/your-feature-name
   ```

---

## Pull Request Requirements

`master` is a protected branch. Every PR must meet the following before it can be merged:

- **At least 1 approving review** from another team member
- **Smoke test CI must pass** (`Pre-Deploy Smoke Test` workflow)
- No unresolved CodeRabbit review comments

### PR Checklist (copy into your PR description)

```markdown
- [ ] Feature branch branched off latest `master`
- [ ] Smoke test passes locally (`npm test`)
- [ ] No secrets or API keys committed
- [ ] REVIEW_NOTES.md updated (for non-trivial changes)
```

---

## Commit Message Format

```
<type>: <short description>
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `style`

Examples:
```
feat: add web search tool with Brave/Google/DDG fallback
fix: resolve race condition in session cleanup
chore: bump express to 4.21.2
docs: add branching strategy to CONTRIBUTING.md
```

---

## What Happened (Why These Rules Exist)

On April 3, 2026, a `git push --force` to `master` overwrote commits from two other teams who were actively working on the same branch. The `rex-tools.mjs` file, the Activity Window features, and the tool-use loop were all lost and had to be recovered manually from the reflog.

**These rules exist to make sure that never happens again.**

See [RAID.md](docs/RAID.md) and the post-mortem in issue #2 for full details.
