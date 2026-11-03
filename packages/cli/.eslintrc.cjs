/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  extends: ["@usesend/eslint-config/library.js"],
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  env: { es2022: true },
  rules: {
    "no-unused-vars": "off",
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    // TypeScript resolves NodeJS namespaces and runtime globals.
    "no-undef": "off",
  },
  parserOptions: {
    project: "./tsconfig.json",
    tsconfigRootDir: __dirname,
  },
};
