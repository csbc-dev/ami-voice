---
name: release
description: Release procedure for the @csbc-dev/ami-voice npm package. Use this skill when the user asks to release, publish, ship, cut a version, bump the version, or prepare a release. The actual `npm publish` step is performed manually by the user - Claude must not run it.
---

# Release procedure for `@csbc-dev/ami-voice`

This skill walks the assistant through the steps required to prepare a release of the `@csbc-dev/ami-voice` package. The assistant prepares everything up to, but not including, the publish step. `npm publish` is run manually by the user.

This repository is currently still in the scaffolding phase, so the first responsibility of the skill is to verify that a publishable package actually exists. If the package manifest, build, and test surfaces are missing, stop and report that the repository is not release-ready yet.

---

## Important constraints

- **Never run `npm publish`.** The user performs publishing manually outside Claude. If the user asks Claude to publish, refuse and remind them this is a manual step.
- **Never run `npm version <bump>` without explicit user approval** because it creates a commit and a git tag.
- **Never push tags or commits to origin** without explicit user approval.
- **Do not skip git hooks** unless the user explicitly asks for it.
- All preparation must happen on a clean working tree. If the tree is dirty, ask the user how to proceed before continuing.

---

## Stage 0: release-readiness gate

Before attempting release work, verify that the repository contains all of the following:

1. `package.json` with a package name of `@csbc-dev/ami-voice`
2. A build script (`npm run build`)
3. A test surface (`npm test` at minimum)
4. A declared package artifact surface (`files`, `exports`, or equivalent)
5. Source files that correspond to the package being released

If any of these are missing, stop and report:

> `@csbc-dev/ami-voice` is not release-ready yet. The repository still needs package scaffolding before a version can be prepared.

Do not invent missing release steps for a repository that has not been scaffolded.

---

## Preflight checks

Once the package exists, run these in parallel and report the results to the user:

1. `git status` - confirm the working tree is clean and the branch is `main` or the branch named by the user
2. `git log --oneline -10` - show what is going into the release
3. Read `package.json` - note the current `version`
4. `npm test` - the test suite must pass
5. `npm run build` - the package must build successfully
6. Verify there are no local-path dependencies in `package.json` `dependencies`

If the change touches the browser microphone data plane (`getUserMedia`, `AudioWorklet`, PCM framing) or the real-time protocol handling, and an integration suite exists, propose running it. A real-mic / real-WSS test is the only thing that catches data-plane regressions; run it on user approval, not automatically.

If any check fails, stop and report. Do not attempt fixes unless the user asks.

---

## Local-path dependency check (MANDATORY before publish)

Once `package.json` exists, it is expected to pin `@wc-bindable/core` and `@wc-bindable/remote` to semver ranges on the **current `@wc-bindable/*` lockstep line — `^0.10.0`** (the whole upstream family, including `composite`, releases at one lockstep version; confirm the latest in the sibling repo's `RELEASE_NOTES.md` before cutting a release and bump both ranges together). It is common during development to temporarily swap one of these for a sibling-monorepo `file:` reference (e.g. `file:../../wc-bindable-protocol/wc-bindable-protocol/packages/core`). **`npm publish` will refuse to publish a package whose `dependencies` contain a `file:` URI**, and downstream `npm install @csbc-dev/ami-voice` on any machine without that exact directory layout would fail.

Before any release-prep step, inspect `package.json` `dependencies` for values starting with:

- `file:`
- `link:`
- `portal:`
- `./`
- `../`

If you find any of them, STOP and surface the dependency as a blocker — do NOT continue with version bump, build verification, or commit.

Once the user replaces local-path dependencies with registry-resolvable semver ranges pointing at the published `@wc-bindable/*` versions the package is built and tested against, re-run `npm install`, `npm test`, and `npm run build` so `package-lock.json` and the suite pick up the published artifacts.

If the user asks "why can't we just publish anyway", remind them that `npm publish` runs its own check and rejects `file:` deps with `EUNSUPPORTEDPROTOCOL` / "Cannot publish a package with a file: dependency".

---

## Version bump

Confirm the next version with the user before bumping. Follow semver:

- **patch** - bug fixes only, no public API changes
- **minor** - backwards-compatible feature additions
- **major** - breaking changes

For this package, the following count as breaking once implementation exists:

- Changes to the `wcBindable` property, input, or command names on `AmiVoiceCore` (e.g. `transcript`, `interim`, `segments`, `recognizing`, `start`, `stop`).
- Changes to the `<ami-voice>` custom element attribute or property contract, or to any child projection tag.
- Changes to exported public types (`IAmiVoiceProvider`, recognition options, normalized result types).
- Changes to the codec / audio-format contract the Shell streams to the Core.
- Changes to the remote wire protocol or the normalized error contract.

> **While the package is in `0.x.y`, map a breaking change to minor and a feature addition or fix to patch.** This is the convention of the upstream `@wc-bindable/*` line and of `@csbc-dev/ai-agent`. Upstream still ships breaking changes as 0.x minors, so a 1.0 here would not be a stable promise. Bump major only once the package is at 1.0 or later.

Prefer editing the `version` field directly in `package.json` rather than running `npm version`, unless the user explicitly wants the automatic commit-and-tag behavior.

---

## Build verification

After the version bump:

1. Run `npm run build` from a clean state.
2. Sanity-check that the built artifacts referenced by `package.json` (`main` / `types` / each `exports` entry) actually exist in `dist/` — including the Node-safe `./server` barrel if present.
3. If the package exports browser auto-entry files from `src/auto/` (`auto`, `remoteEnv`), verify those files are up to date with the source they depend on; they are shipped from `src/auto/`, not generated by `tsc`.
4. Run `npm pack --dry-run` and inspect the tarball contents against the `files` field. Watch for accidentally-included files (`__tests__/`, `tests/`, `test-results/`, `node_modules/`, etc.).

---

## Documentation

- Update any version reference in `README.md` or `CLAUDE.md` if they cite a specific released version.
- If the public API changed (component attributes, exported types, error contract, bindable surface), verify the README reflects the current contract before release.
- If the repository has a changelog, add an entry. If it does not, ask the user whether to start one rather than creating it unprompted.

---

## Commit and tag (with user approval)

When the user approves the prepared changes, propose a single commit:

```text
chore(release): v<new-version>
```

Then propose creating an annotated tag `v<new-version>`. Run `git commit` and `git tag` only after the user approves. Do not push.

---

## Hand-off for manual publish

After the commit and tag are created locally, hand off to the user with a checklist they will run manually:

```bash
# user runs these manually - Claude does not execute them
git push origin main
git push origin v<new-version>
npm publish --access public
```

Use `--access public` because `@csbc-dev/ami-voice` is a scoped package. Remind the user to verify the published version on npm after publishing, and to spot-check that `npm install @csbc-dev/ami-voice` from a scratch directory pulls down the published `@wc-bindable/core` and `@wc-bindable/remote` (i.e. the local-path-dependency check actually held).

---

## If something goes wrong after publish

If the user reports a problem after running `npm publish`:

- Do not suggest `npm unpublish` for a stable version as the first response — npm restricts unpublish for packages live more than 72 hours, and even within the window it can break downstream installs.
- Recommend `npm deprecate @csbc-dev/ami-voice@<bad-version> "<message>"` and then preparing a new patch release through this same skill.
- If the bad version was tagged `latest`, mention `npm dist-tag` as a manual recovery mechanism for re-pointing `latest` at the previous good version.
