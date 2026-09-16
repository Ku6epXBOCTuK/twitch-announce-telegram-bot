/**
 * @see https://prettier.io
 * @type {import("prettier").Config}
 */
const config = {
	useTabs: true,
	singleQuote: false,
	trailingComma: "all",
	printWidth: 80,
	proseWrap: "always",
	endOfLine: "lf",
	overrides: [
		{
			files: "*.md",
			options: {
				useTabs: false,
			},
		},
	],
};

export default config;
