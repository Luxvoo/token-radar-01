// main.ts — Token Radar entry point: a snapshot in, a ranked board out.
//
// Reads the sealed DefiLlama snapshot, builds the radar-2 board, and writes the
// output directory the grader reads: board.json, the dashboard data, the dashboard
// itself, the screenshots, and the dossier. Node 22+, standard library only, no
// install and no build step.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
//
// Without --input it reads /input/snapshot.json; without MAKEFUN_OUTPUT_DIR it writes
// /output.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBoard } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoRoot = dirname(fileURLToPath(import.meta.url));

function inputPath(argv: string[]): string {
  const at = argv.indexOf('--input');
  if (at >= 0 && argv[at + 1]) return argv[at + 1] as string;
  const eq = argv.find((a) => a.startsWith('--input='));
  if (eq) return eq.slice('--input='.length);
  return '/input/snapshot.json';
}

// The input is a snapshot file, or a directory holding snapshot.json.
function snapshotPath(input: string): string {
  const abs = resolve(input);
  if (existsSync(abs) && statSync(abs).isDirectory()) return join(abs, 'snapshot.json');
  return abs;
}

function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

function main(): void {
  const snapshot = JSON.parse(readFileSync(snapshotPath(inputPath(process.argv.slice(2))), 'utf8'));
  if (!snapshot || !Array.isArray(snapshot.protocols) || !Array.isArray(snapshot.watchlist)) {
    throw new Error('snapshot must hold protocols and a watchlist');
  }
  const outDir = resolve(process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
  const board = buildBoard(snapshot);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'board.json'), JSON.stringify(board, null, 2) + '\n', 'utf8');
  writeFileSync(join(outDir, 'data.js'), `window.RADAR = ${JSON.stringify(board)};\n`, 'utf8');
  copyDir(join(repoRoot, 'dashboard'), join(outDir, 'dashboard'));
  copyDir(join(repoRoot, 'screenshots'), join(outDir, 'screenshots'));
  // The dossier is last: it is computed from the dashboard and screenshots above,
  // and the scorer requires dossier.json to equal what buildDossier writes.
  writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, { text_max_bytes: 65536 }));

  const top = board.rows[0] as { slug: string; implied_value_usd: number };
  console.log(`board: ${board.rows.length} rows, top ${top.slug} $${top.implied_value_usd}`);
  console.log(`wrote ${outDir}/board.json, ${outDir}/data.js, ${outDir}/dashboard/, ${outDir}/screenshots/, ${outDir}/dossier.json`);
}

main();
