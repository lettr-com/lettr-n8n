module.exports = {
	root: true,
	parser: '@typescript-eslint/parser',
	parserOptions: {
		project: ['./tsconfig.json'],
		sourceType: 'module',
	},
	plugins: ['n8n-nodes-base'],
	extends: ['plugin:n8n-nodes-base/community'],
	ignorePatterns: ['dist/**'],
	overrides: [
		{
			// JS config files are not part of tsconfig.json, so disable the
			// type-aware parser for them to avoid "parserOptions.project" errors.
			files: ['*.js'],
			parserOptions: {
				project: null,
			},
		},
	],
};
