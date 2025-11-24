// jest.config.js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testTimeout: 60_000,
  roots: ['<rootDir>/__tests__'],
  collectCoverage: true,
  verbose: true
};
