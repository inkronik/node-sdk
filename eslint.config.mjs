import { codemaskConfig, codemaskImportConfig } from 'eslint-config-codemask'

export default [
    { ignores: ['dist/**', 'eslint.config.mjs'] },
    ...codemaskConfig,
    ...codemaskImportConfig,
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parserOptions: {
                project: './tsconfig.json',
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            camelcase: 'off',
            'import/order': [
                'error',
                {
                    groups: ['builtin', 'external', 'internal', ['sibling', 'parent'], 'index'],
                    pathGroups: [
                        {
                            pattern: '*',
                            group: 'external',
                            position: 'before',
                        },
                        {
                            pattern: '@*/**',
                            group: 'external',
                            position: 'after',
                        },
                    ],
                    pathGroupsExcludedImportTypes: ['builtin'],
                    warnOnUnassignedImports: true,
                },
            ],
            'no-param-reassign': 'error',
            'no-var': 'error',
            'prefer-const': 'error',
        },
    },
]
