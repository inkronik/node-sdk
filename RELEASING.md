# Releasing

`@inkronik/node` is published from the `Release to npm` GitHub Actions workflow through npm Trusted Publishing. The workflow does not use a
long-lived npm write token.

## Bootstrap the npm package

npm requires a package to exist before a trusted publisher can be configured. For the first version only, a package owner must publish the
already verified package from a clean local checkout using an npm account with two-factor authentication:

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
bun run check:lint
bun run check:format
bun run build
npm pack --dry-run
npm publish --access public
```

Do not create a GitHub Release for that same version: the release workflow would correctly reject npm's duplicate-version error. Start using
GitHub Releases with the next version.

## One-time trusted-publisher configuration

After the bootstrap version exists, configure a trusted publisher for `@inkronik/node` in npm with these values:

- provider: GitHub Actions;
- organisation or user: `inkronik`;
- repository: `node-sdk`;
- workflow filename: `release.yaml`;
- environment: `npm`.

The GitHub `npm` environment can optionally require reviewers. The release workflow requires a GitHub-hosted runner because npm Trusted
Publishing does not support self-hosted runners.

## Publish a version

1. Update `version` in `package.json` and run `bun install` so the lockfile records the same package version.
2. Run `bun test`, `bun run typecheck`, `bun run check:lint`, `bun run check:format`, `bun run build`, and `npm pack --dry-run`.
3. Merge the version change to `main`.
4. Publish a GitHub Release tagged `v<package-version>`, for example `v1.0.0`.

The workflow rejects a release whose tag does not equal `v` followed by the exact `package.json` version. It then repeats all verification,
builds the package, inspects its contents, and publishes it publicly to npm. Trusted Publishing supplies the npm provenance attestation.
