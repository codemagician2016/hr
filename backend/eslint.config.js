'use strict';

// Vertical isolation lint rules.
//
// The four non-core verticals (appointment / shop / web / superadmin) must not
// import from each other's route folders. core/ is shared infrastructure
// and may be imported by any vertical.
//
// ESLint flat config (v9+). Uses no-restricted-syntax with require() AST
// selectors because the backend is CommonJS (no-restricted-imports only
// fires on ES module `import` statements).

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
  {
    files: ['src/routes/appointment/**/*.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.type='Literal'][arguments.0.value=/^\\.\\.\\/shop/]",
          message:
            'Cross-vertical import forbidden: appointment/ must not require from shop/.',
        },
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.type='Literal'][arguments.0.value=/^\\.\\.\\/web/]",
          message:
            'Cross-vertical import forbidden: appointment/ must not require from web/.',
        },
      ],
    },
  },
  {
    files: ['src/routes/shop/**/*.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.type='Literal'][arguments.0.value=/^\\.\\.\\/appointment/]",
          message:
            'Cross-vertical import forbidden: shop/ must not require from appointment/.',
        },
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.type='Literal'][arguments.0.value=/^\\.\\.\\/web/]",
          message:
            'Cross-vertical import forbidden: shop/ must not require from web/.',
        },
      ],
    },
  },
  {
    files: ['src/web/routes/**/*.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.type='Literal'][arguments.0.value=/^\\.\\.\\/appointment/]",
          message:
            'Cross-vertical import forbidden: web/ must not require from appointment/.',
        },
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.type='Literal'][arguments.0.value=/^\\.\\.\\/shop/]",
          message:
            'Cross-vertical import forbidden: web/ must not require from shop/.',
        },
      ],
    },
  },
];
