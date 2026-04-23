import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["main.js", "main.js.map", "node_modules/**", "test/.compiled/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // Plugin conventions — relaxed from defaults where they fight the Obsidian API.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Obsidian API sometimes returns unawaited promises intentionally
      "@typescript-eslint/no-floating-promises": "off",
      // We cast `app as unknown as ...` in a couple of places to reach
      // internal-plugins options that aren't in the public d.ts
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);
