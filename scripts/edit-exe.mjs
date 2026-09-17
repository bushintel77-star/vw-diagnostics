// Post-build exe resource editing.
//
// electron-builder normally embeds the icon/version into the exe via rcedit,
// but that path is disabled (win.signAndEditExecutable: false) because this
// machine cannot extract electron-builder's winCodeSign tool cache (symlink
// privilege). This script applies the same edits using the standalone
// rcedit binary in build/tools/.
//
// Usage: node scripts/edit-exe.mjs [path-to-exe]
//        (defaults to dist/win-unpacked/vw-diagnostics.exe)

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const exe =
  process.argv[2] || path.join(root, "dist", "win-unpacked", `${pkg.name}.exe`);
const rcedit = path.join(root, "build", "tools", "rcedit-x64.exe");
const icon = path.join(root, "build", "icon.ico");

if (!existsSync(exe)) {
  console.error(`edit-exe: exe not found: ${exe}`);
  process.exit(1);
}
if (!existsSync(rcedit)) {
  console.error(`edit-exe: rcedit not found: ${rcedit}`);
  process.exit(1);
}

const args = [
  exe,
  "--set-icon",
  icon,
  "--set-version-string",
  "ProductName",
  "VW Diagnostics",
  "--set-version-string",
  "FileDescription",
  "VW Diagnostics",
  "--set-version-string",
  "InternalName",
  pkg.name,
  "--set-version-string",
  "OriginalFilename",
  `${pkg.name}.exe`,
  "--set-file-version",
  pkg.version,
  "--set-product-version",
  pkg.version
];

console.log(`edit-exe: applying icon + version to ${path.basename(exe)}`);
const result = spawnSync(rcedit, args, { stdio: "inherit" });
if (result.status !== 0) {
  console.error(`edit-exe: rcedit failed with status ${result.status}`);
  process.exit(result.status ?? 1);
}
console.log("edit-exe: done");
