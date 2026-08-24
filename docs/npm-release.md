# Publish the Rivetplane CLI to npm

The public package and executable are both named `rivetplane`.

The npm registry returned `404 Not Found` for `rivetplane` on 2026-08-24. This result means that the name was available at that time. It does not reserve the name. Check it again immediately before the first release:

```sh
npm view rivetplane name version
```

An npm `404` is the expected result before the first publication. If another publisher takes the name, use `@rivetplane/cli` as the fallback. Change the `name` field but keep the `rivetplane` bin name. The public commands would then be `npx @rivetplane/cli login --server <url>` and `npx @rivetplane/cli`.

Do not publish a different final name without product approval.

## Release controls

The `.github/workflows/publish-npm.yml` workflow is the only normal publication path. It runs for tags in the form `rivetplane-v<version>`. It checks that the tag points to `main`, checks that the tag matches `packages/client/package.json`, runs all type checks and tests, inspects the npm dry-run, installs the tarball in a clean temporary project, and tests the CLI before it publishes.

Create a GitHub environment named `npm` and limit it to `rivetplane-v*` tags. Add a required reviewer if the repository plan supports this rule. Protect the `rivetplane-v*` tag pattern in the repository rules. The workflow uses a GitHub-hosted runner and requests `id-token: write` for npm OIDC. It does not contain an npm token.

## First publication

npm requires the package to exist before a trusted publisher can be attached. After the package name is approved, use this one-time CI/CD bootstrap:

1. Create or select the npm owner account. Enable account-level two-factor authentication. If a company must own the package, create the npm organization first and make the release operator an owner.
2. Create a short-lived, granular npm access token that can create the public `rivetplane` package. Store it only as the `NPM_TOKEN` secret in the protected GitHub `npm` environment. Do not put it in a file, commit, issue, or workflow.
3. Merge the release files to `main`. Add and push a matching `rivetplane-v<version>` tag. Approve the protected GitHub environment deployment. The workflow publishes the package with provenance.
4. On npmjs.com, open `rivetplane` package settings and add a GitHub Actions trusted publisher with these exact values:

   - Organization or user: `rivetplane`
   - Repository: `cli`
   - Workflow filename: `publish-npm.yml`
   - Environment name: `npm`
   - Allowed action: `npm publish`

5. Delete the `NPM_TOKEN` GitHub secret and revoke the short-lived npm token. Set the package to reject token-based publishing if the npm package settings offer that control. Later releases use OIDC only and get npm provenance automatically.

The optional command-line form for step 4 requires npm 11.15 or later and an interactive npm login with 2FA:

```sh
npm trust github rivetplane --repo rivetplane/cli --file publish-npm.yml --environment npm --allow-publish
```

## Make a release

Use semantic versioning. Make breaking changes a major release, compatible features a minor release, and compatible fixes a patch release.

```sh
cd packages/client
npm version patch --no-git-tag-version
cd ../..
bun install
bun run client:package:verify
git add packages/client/package.json bun.lock
git commit -m "release: rivetplane v0.1.1"
git push origin main
git tag -s rivetplane-v0.1.1 -m "rivetplane v0.1.1"
git push origin rivetplane-v0.1.1
```

Use `minor` or `major` instead of `patch` when required. Change the example version in the commit and tag to the version in `packages/client/package.json`. The protected `npm` environment pauses the publish job for approval. Do not run `npm publish` from a developer machine.

After the workflow completes, confirm the published version and provenance on npm:

```sh
npm view rivetplane name version dist-tags repository engines license
```

## Public commands

```sh
npx rivetplane login --server https://harness-control-plane-dimavedenyapin.fly.dev
npx rivetplane
npx rivetplane --help
```

Node.js 22 or later is required. `login` stores credentials and exits. The plain command must stay running while it discovers local harnesses and relays their events.
