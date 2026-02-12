module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true
  },
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended", "prettier"],
  ignorePatterns: ["**/.next/**", "**/dist/**", "**/node_modules/**", "apps/web/next-env.d.ts"],
  overrides: [
    {
      files: ["apps/web/**/*.{ts,tsx}"],
      extends: ["next/core-web-vitals"],
      settings: {
        next: {
          rootDir: "apps/web"
        }
      }
    }
  ]
};
