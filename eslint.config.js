// ESLint flat config for the jev-pi extension.
// Rules are tuned for pi extension code: in-place event mutation is the documented
// pattern, and tests use a tiny zero-dep harness.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{ ignores: ["node_modules/", ".pi/"] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: "module",
		},
		rules: {
			// pi's documented pattern: mutate `event.input` / `event.systemPromptOptions` in place.
			"no-param-reassign": "off",
			// hook payloads are trusted internal objects with late-bound shapes.
			"@typescript-eslint/no-explicit-any": "warn",
			"@typescript-eslint/no-unsafe-function-type": "off",
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
			],
		},
	},
	{
		files: ["tests/**/*.ts"],
		rules: {
			// tests construct partial hook payloads on purpose.
			"@typescript-eslint/no-explicit-any": "off",
		},
	},
);
