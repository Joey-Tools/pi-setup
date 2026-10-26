// Syntax-check every .mjs file without installing anything.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = [];
const walk = (dir) => {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(p);
		else if (entry.name.endsWith(".mjs")) files.push(p);
	}
};
for (const dir of ["lib", "test", "scripts"]) walk(path.join(root, dir));

let failed = 0;
for (const file of files) {
	const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
	if (r.status !== 0) {
		failed++;
		process.stderr.write(`${path.relative(root, file)}\n${r.stderr}\n`);
	}
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
for (const ext of manifest.pi.extensions) {
	if (!fs.existsSync(path.join(root, ext))) {
		failed++;
		process.stderr.write(`missing extension ${ext}\n`);
	}
}
console.log(`checked ${files.length} files${failed ? `, ${failed} failed` : ", ok"}`);
process.exit(failed ? 1 : 0);
