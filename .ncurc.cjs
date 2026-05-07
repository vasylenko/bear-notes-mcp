// Per-package upgrade policy for npm-check-updates (used by `task deps:dev`
// and `task deps:prod` in Taskfile.yml). Captures version constraints that
// can't be expressed in package.json's semver ranges alone, with rationale
// for each so a future maintainer (or future-me) can revisit deliberately
// rather than blindly relax.
module.exports = {
  // Per-package target override. Default 'latest' = latest stable release.
  // 'minor' = stay within the current major (allow minor + patch upgrades).
  target: (name) => {
    // @types/node must track engines.node (^24.13.0). Bumping to 25.x ships
    // type definitions for Node 25 APIs that don't exist on the deployment
    // target — TypeScript would let through code that crashes at runtime.
    if (name === '@types/node') return 'minor';

    // typescript 6.0 changed `bundler` moduleResolution behavior so that
    // @types/* packages are no longer auto-included; explicit
    // `types: ["node"]` in tsconfig.json becomes required. Defer that
    // migration to a focused PR; restrict here to within current major.
    if (name === 'typescript') return 'minor';

    return 'latest';
  },
};
