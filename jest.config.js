/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.{js,ts}'],
  transform: {
    '^.+\\.(js|ts)$': ['babel-jest', { configFile: './babel.config.cjs' }]
  },
  moduleFileExtensions: ['js', 'ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/index.ts'
  ]
};