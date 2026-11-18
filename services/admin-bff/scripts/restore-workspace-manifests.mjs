#!/usr/bin/env node
/**
 * Docker-сборка из корня монорепозитория: `npm ci` сверяет корневой package-lock.json со ВСЕМИ workspace'ами
 * из package.json и падает, если package.json какого-то workspace'а отсутствует. Каталоги apps/* исключены
 * корневым .dockerignore, поэтому их package.json восстанавливается из записи в package-lock.json
 * (те же поля зависимостей → lock остаётся согласованным, лишнего не ставится при `npm ci -w <пакет>`).
 *
 *   node services/admin-bff/scripts/restore-workspace-manifests.mjs [корень-репозитория]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bin", "engines"];

let restored = 0;
for (const ws of pkg.workspaces ?? []) {
  if (ws.includes("*")) {
    console.error(`restore-workspace-manifests: glob workspaces are not supported (${ws})`);
    process.exit(1);
  }
  const manifest = join(root, ws, "package.json");
  if (existsSync(manifest)) continue;
  const entry = lock.packages?.[ws];
  if (!entry) {
    console.error(`restore-workspace-manifests: no package-lock entry for workspace ${ws}`);
    process.exit(1);
  }
  const out = { name: entry.name, version: entry.version, private: true };
  for (const f of FIELDS) if (entry[f]) out[f] = entry[f];
  mkdirSync(join(root, ws), { recursive: true });
  writeFileSync(manifest, `${JSON.stringify(out, null, 2)}\n`);
  restored += 1;
  console.log(`restore-workspace-manifests: ${ws}/package.json restored from package-lock.json`);
}
if (restored === 0) console.log("restore-workspace-manifests: all workspace manifests present");
