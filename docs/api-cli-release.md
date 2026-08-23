# API CLI release

The API consumer package is `@rivetplane/api-cli`. Its executable is `rivetplane-api`. The local harness runner remains the `rivetplane` package and executable.

## First release

1. Merge and publish `@rivetplane/sdk` version 0.1.0 from its canonical `rivetplane/typescript-sdk` repository.
2. Create the `@rivetplane/api-cli` package in the Rivetplane npm organization if the first workflow run does not create it.
3. Create a protected GitHub environment named `npm`.
4. For the first publication, add a short-lived granular npm token as the `NPM_TOKEN` environment secret.
5. Merge the API CLI pull request.
6. Create and push the signed tag `api-cli-v0.1.0` from the main branch.
7. Configure npm trusted publishing for `rivetplane/cli`, workflow `publish-api-cli.yml`, and environment `npm`.
8. Delete and revoke `NPM_TOKEN` after trusted publishing works.

Do not publish the CLI before the matching SDK version is public. The publish workflow installs the declared SDK dependency from npm and fails if it is missing.

## Later releases

1. Update `packages/api-cli/package.json` with a semantic version.
2. Run the type check, tests, and package inspection.
3. Merge the change to main.
4. Push `api-cli-v<version>` from that main commit.

The workflow checks the tag, verifies that the commit is on main, rejects duplicate versions, and publishes with npm provenance.
