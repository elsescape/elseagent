import tailwind from "bun-plugin-tailwind";

/**
 * Build the single-file executable, with the web UI (src/web) bundled into it.
 *
 *   bun scripts/build.ts [--target=bun-linux-x64] [--outfile=dist/elseagent] [--release]
 *
 * This is `bun build --compile` through the JS API: the CLI can't run the Tailwind plugin
 * the web UI's stylesheet needs. `--release` minifies and adds a source map.
 */
const args = Bun.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const release = args.includes("--release");
const outfile = flag("outfile") ?? "dist/elseagent";
const target = flag("target") as Bun.Build.CompileTarget | undefined;

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  plugins: [tailwind],
  minify: release,
  sourcemap: release ? "linked" : "none",
  compile: target ? { outfile, target } : { outfile },
});
for (const log of result.logs) console.log(log);
if (!result.success) process.exit(1);
console.log(`built ${outfile}`);
