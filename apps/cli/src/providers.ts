/**
 * Provider presets, re-exported.
 *
 * The built-in endpoint this file used to hold is gone: the CLI is BYOK-only, so
 * there is no baked-in host to fall back to. What lives here now is the
 * per-provider data the OAuth and transport layers are parameterised by — see
 * `provider-presets.ts`. This module is kept as the import path the rest of the
 * CLI already uses.
 */
export * from "./provider-presets.js";
