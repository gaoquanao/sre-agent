/**
 * DeepSeek Harness plugin contract notes (verified against dsh 0.2.0-rc.2).
 *
 * Module resolution — why this package declares no dependencies:
 *
 * `@deepseek-ai/dsh-tools` holds a module-local `Symbol()` (`TOOL_RUNTIME_SCHEDULER`)
 * that the agent loop reads back off the tool service instance. If a plugin pulls
 * in a *second* copy of that package, the two symbols differ and every tool
 * dispatch fails with `Cannot read properties of undefined (reading 'prepare')`.
 *
 * The harness resolves `@deepseek-ai/*` imports made by profile plugins against
 * its own installation, but only when the plugin is installed the way
 * `dsh plugin add` does it (a link/symlink whose real path stays outside the
 * profile). A copy placed directly inside the profile gets a duplicate module
 * graph. The platform therefore symlinks this package into the profile rather
 * than copying it, and declares no `dependencies` / `peerDependencies` here so
 * nothing can hoist a second copy.
 *
 * Plugin ABI notes:
 * - named exports only; a default export makes the loader drop `inject`
 * - `inject: ['tools']` gates `apply` until the tool registry exists
 * - `tools/pre-execute` may await indefinitely; it must observe `exec.signal`
 *   and decide fail-closed on its own timeout
 */
export {}
