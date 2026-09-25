const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  // The recommended rule set (a single flat-config entry in @eslint/js v9).
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    ignores: ['node_modules'],
    rules: {
      // Relax a few recommended rules that fight common Node patterns here.
      // The real gate is node --test; lint is a hygiene net for real bugs.
      // prefer-template is a pure style nit — off so the gate stays green.
      'prefer-template': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Service worker: browser globals, not Node.
    files: ['public/sw.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
      },
    },
  },
];
