# Releasing

`@inkronik/node-sdk` is released from the `Release` GitHub Actions workflow. Release It performs the version bump, release commit, Git tag, push,
GitHub Release, and npm publication. Publication runs only after the release commit and tag have been pushed. The workflow runs the full test,
typecheck, lint, format, build, and package-content checks before changing anything.

## Workflow inputs

- `branch`: `main` for stable releases or `rc` for release candidates;
- `dry_run`: validates and previews the release without committing, tagging, pushing, creating a GitHub Release, or publishing to npm.

`dry_run` defaults to `true`. Run a dry run first, then repeat the same inputs with `dry_run` disabled.

## Automatic versioning

The workflow calculates the next version from Conventional Commits since the latest version tag:

- `fix`, `perf`, and `revert` create a patch release;
- `feat` creates a minor release;
- a `BREAKING CHANGE` footer or `!` after the type creates a major release;
- documentation, test, build, CI, refactor, style, and chore-only changes do not create a release.

If there are no releasable commits, the workflow stops before creating a tag or publishing to npm. Manual version increments are intentionally
not exposed as workflow inputs.

### Release candidates

The `rc` branch must exist on GitHub before it can be selected. The same commit analysis determines the target version, and prereleases are
published as `-rc.N` under the npm `rc` dist-tag.

## npm publication

The release workflow publishes exclusively through npm Trusted Publishing and GitHub Actions OIDC. It does not read an `NPM_TOKEN` or export
`NODE_AUTH_TOKEN`. The job runs on a GitHub-hosted runner with `id-token: write`, Node 24, npm 11.18, and the protected `npm` environment.

Remove any obsolete `NPM_TOKEN` repository or environment secret and revoke the corresponding npm automation token. If private npm dependencies
are added later, use a separate read-only token only on the dependency-install step; the publish step must remain tokenless.

The workflow requires permission to push its release commit and tag to the selected branch. If a branch ruleset blocks GitHub Actions, allow
this workflow to bypass the rule or use a release-specific GitHub App token.

## Enable npm Trusted Publishing

After `@inkronik/node-sdk` exists on npm, configure its trusted publisher with:

- provider: GitHub Actions;
- organisation or user: `inkronik`;
- repository: `node-sdk`;
- workflow filename: `release.yaml`;
- environment: `npm`;
- allowed action: `npm publish`.

The same configuration can be created with npm CLI 11.15 or newer:

```bash
npx npm@11.18.0 trust github @inkronik/node-sdk \
  --repo inkronik/node-sdk \
  --file release.yaml \
  --environment npm \
  --allow-publish
```

npm generates provenance automatically for OIDC publications. The package repository URL, workflow filename, and `npm` environment must continue
to match the trusted-publisher configuration exactly.
