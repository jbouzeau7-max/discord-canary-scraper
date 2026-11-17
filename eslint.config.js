// Config ESLint (flat config, ESLint 9). Lancer : npm run lint
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      '.mobile_datamine/**',
      'builds/**',
      'assets/**',
      'data/**',
      'chunks/**',
      'css/**',
      // Worker Cloudflare (module ESM, hors périmètre lint Node CommonJS)
      'relay/**',
      // Fragment injecté dans quests.js (pas un module autonome)
      'scripts/build_quest_v2_snippet.js',
    ],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
];
