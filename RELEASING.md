# Releasing

`@inkronik/node` is released from the `Release` GitHub Actions workflow. Release It performs the version bump, release commit, Git tag, push,
GitHub Release, and npm publication. Publication runs only after the release commit and tag have been pushed. The workflow runs the full test,
typecheck, lint, format, build, and package-content checks before changing anything.

## Workflow inputs

- `increment`: `current`, `patch`, `minor`, or `major`;
- `branch`: `main` for stable releases or `rc` for release candidates;
- `dry_run`: validates and previews the release without committing, tagging, pushing, creating a GitHub Release, or publishing to npm.

`dry_run` defaults to `true`. Run a dry run first, then repeat the same inputs with `dry_run` disabled.

### Stable releases

On `main`, `patch`, `minor`, and `major` create the corresponding stable version. `current` publishes the exact version already present in
`package.json`; it exists primarily for the initial `1.0.0` bootstrap and should not be used if that version already exists on npm.

### Release candidates

The `rc` branch must exist on GitHub before it can be selected. To start a new prerelease series, select `rc` and one of `patch`, `minor`, or
`major`. For example, selecting `minor` after `1.0.0` creates `1.1.0-rc.0` and publishes it under the npm `rc` dist-tag. To continue an existing
series with `-rc.1`, `-rc.2`, and so on, select `rc` and `current`.

## Bootstrap npm publication

npm requires a package to exist before Trusted Publishing can be configured. The temporary `NPM_TOKEN` GitHub secret is used automatically
when present. For the first publication:

1. Open GitHub Actions and select the `Release` workflow.
2. Select `current`, `main`, and keep `dry_run` enabled.
3. If the dry run succeeds, repeat with `dry_run` disabled to publish `1.0.0`.

The workflow requires permission to push its release commit and tag to the selected branch. If a branch ruleset blocks GitHub Actions, allow
this workflow to bypass the rule or use a release-specific GitHub App token.

## Enable npm Trusted Publishing

After `@inkronik/node` exists on npm, configure its trusted publisher with:

- provider: GitHub Actions;
- organisation or user: `inkronik`;
- repository: `node-sdk`;
- workflow filename: `release.yaml`;
- environment: `npm`;
- allowed action: `npm publish`.

The same configuration can be created with npm CLI 11.15 or newer:

```bash
npx npm@11.18.0 trust github @inkronik/node \
  --repo inkronik/node-sdk \
  --file release.yaml \
  --environment npm \
  --allow-publish
```

After verifying the first OIDC-backed release, delete the `NPM_TOKEN` GitHub secret and revoke the token on npm. The workflow detects the
missing secret and publishes through Trusted Publishing instead. npm generates provenance automatically for OIDC publications.
