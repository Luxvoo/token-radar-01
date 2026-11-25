import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRadar } from './lib/model.ts';
import type { Snapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

function inputPathFromArgs(argv: string[]): string {
  const at = argv.indexOf('--input');
  const given = at >= 0 ? argv[at + 1] : undefined;
  const raw = given ?? '/input/snapshot.json';
  try {
    return statSync(raw).isDirectory() ? join(raw, 'snapshot.json') : raw;
  } catch {
    return raw;
  }
}

const repoRoot = dirname(fileURLToPath(import.meta.url));
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ? resolve(process.env.MAKEFUN_OUTPUT_DIR) : '/output';
const snapshot = JSON.parse(readFileSync(inputPathFromArgs(process.argv.slice(2)), 'utf8')) as Snapshot;
const { board, data } = buildRadar(snapshot);

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'board.json'), `${JSON.stringify(board, null, 2)}\n`);
writeFileSync(join(outputDir, 'data.js'), `window.RADAR = ${JSON.stringify(data)};\n`);

for (const name of ['dashboard', 'screenshots']) {
  rmSync(join(outputDir, name), { recursive: true, force: true });
  cpSync(join(repoRoot, name), join(outputDir, name), { recursive: true });
}

writeFileSync(join(outputDir, 'dossier.json'), buildDossier(outputDir, { text_max_bytes: 65536 }));
