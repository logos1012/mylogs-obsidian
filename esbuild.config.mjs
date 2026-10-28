import esbuild from "esbuild";
import process from "node:process";
import { builtinModules } from "node:module";

const banner = `/*
MyLogs for Obsidian — bundled by esbuild. Source: https://github.com/logos1012/mylogs-obsidian
*/
var __mylogsMetaUrl = (function () { try { return require("url").pathToFileURL(typeof __filename === "string" && __filename ? __filename : "/mylogs-main.js").href; } catch (e) { return "file:///mylogs-main.js"; } })();`;

const prod = process.argv[2] === "production";

const context = await esbuild.context({
	banner: { js: banner },
	entryPoints: ["src/main.ts"],
	bundle: true,
	// 루미's agent SDKs are ESM; in this CommonJS bundle `import.meta.url` comes from the banner.
	define: { "import.meta.url": "__mylogsMetaUrl" },
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtinModules,
		...builtinModules.map((m) => `node:${m}`),
	],
	format: "cjs",
	target: "es2020",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	outfile: "main.js",
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
