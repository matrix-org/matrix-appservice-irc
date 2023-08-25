const isGithubActions = process.env.GITHUB_ACTIONS === 'true';
/** @type {import('ts-jest/dist/types').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transformIgnorePatterns: ['<rootDir>/node_modules/'],
  testTimeout: 60000,
  reporters: isGithubActions ? [['github-actions', {silent: false}], 'summary'] : ['default'],
  transform: {
    // Use the root tsconfig.json
    // https://kulshekhar.github.io/ts-jest/docs/getting-started/options/tsconfig/#examples
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: './tsconfig.json',
      },
    ],
  },
};
