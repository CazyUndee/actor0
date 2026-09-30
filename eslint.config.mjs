// ESLint flat config. ESLint 9 requires this file; without it `npm run lint`
// fails before linting a single file, which is why the script in package.json
// had been red since the initial commit.
//
// It is `.mjs` rather than `.js` because the root package.json has no
// `"type": "module"` — a bare `eslint.config.js` here would be parsed as
// CommonJS, which is legal but reads oddly in a workspace whose packages are
// all ESM.
//
// The rule set is deliberately `recommended` rather than type-checked. `tsc
// --strict` already runs over every source file in `npm run typecheck`, and it
// is the faster, more trustworthy signal for a TypeScript-only repository.
// Adding `tseslint.configs.recommendedTypeChecked` on top would mostly re-report
// what tsc already rejects, and would make lint slow enough that people skip it.
import js from '@eslint/js'
import react from 'eslint-plugin-react'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // Build output and the tsbuildinfo files that sit beside the sources. These
    // are gitignored, but a stale `dist/` from a previous build would otherwise
    // be linted as if it were source.
    //
    // `.freebuff/` is agent scratch: patch scripts, probe outputs and source
    // fragments kept out of the tree by `.gitignore`. ESLint does not read
    // `.gitignore`, so without naming it here a half-finished fragment — which is
    // what scratch is, most of the time — fails `npm run lint` for whoever
    // happens to be running it.
    ignores: ['**/dist/**', '**/node_modules/**', '**/target/**', '.freebuff/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
  {
    // `generate-theme.mjs` and friends are plain Node scripts: they legitimately
    // reach for `process` and `console`, and `no-undef` has no way to know that
    // unless it is told. Scoped to the scripts so the TypeScript sources keep
    // the stricter default.
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // The React plugin is enabled for two reasons. The obvious one is that
    // `apps/cli/src/ui/parts.tsx` already carries an
    // `eslint-disable-next-line react/no-array-index-key` comment, and ESLint
    // reports an unknown rule as an error — so with no plugin installed, that
    // suppression was itself a lint failure. The less obvious one is that a TUI
    // is React code, and the JSX rules are the ones worth having on it.
    //
    // Only the rules that apply to a TypeScript Ink app are turned on.
    // `plugin:react/recommended` is deliberately not used: its `react/prop-types`
    // rule demands runtime prop validation that TypeScript already provides
    // here, and enabling it reports every typed component as an error.
    files: ['**/*.tsx'],
    plugins: { react },
    settings: { react: { version: 'detect' } },
    rules: {
      'react/no-array-index-key': 'error',
      'react/jsx-key': 'error',
      'react/jsx-no-undef': 'error',
      'react/no-unknown-property': 'error',
    },
  },
  {
    // Tests routinely take unused parameters — the harness tests in particular
    // accept an unused abort signal or clock in several cases — and a leading
    // underscore is this repository's way of saying "deliberately unused".
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
)
