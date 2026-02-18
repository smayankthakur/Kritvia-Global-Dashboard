module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: "..",
  testRegex: "test/.*\\.e2e-spec\\.ts$",
  transform: {
    "^.+\\.(t|j)s$": ["ts-jest", { tsconfig: "tsconfig.spec.json" }]
  },
  testEnvironment: "node",
  setupFiles: ["<rootDir>/test/test-env.ts"]
};
