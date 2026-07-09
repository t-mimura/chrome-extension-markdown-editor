/**
 * package.json と manifest.json のバージョンを同時に更新する。
 *
 * 使い方:
 *   node scripts/bump-version.mjs patch
 *   node scripts/bump-version.mjs minor
 *   node scripts/bump-version.mjs major
 *   node scripts/bump-version.mjs 1.2.3
 */

import { readFileSync, writeFileSync } from 'fs';

const PACKAGE_PATH = 'package.json';
const MANIFEST_PATH = 'manifest.json';

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/bump-version.mjs <patch|minor|major|x.y.z>');
  process.exit(1);
}

const semverPattern = /^\d+\.\d+\.\d+$/;

function parseVersion(version) {
  if (!semverPattern.test(version)) {
    throw new Error(`Invalid version: ${version}`);
  }
  const [major, minor, patch] = version.split('.').map((v) => Number(v));
  return { major, minor, patch };
}

function bumpVersion(current, mode) {
  const v = parseVersion(current);
  if (mode === 'patch') return `${v.major}.${v.minor}.${v.patch + 1}`;
  if (mode === 'minor') return `${v.major}.${v.minor + 1}.0`;
  if (mode === 'major') return `${v.major + 1}.0.0`;
  return mode;
}

const packageJson = JSON.parse(readFileSync(PACKAGE_PATH, 'utf-8'));
const manifestJson = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));

const current = String(packageJson.version ?? '');
parseVersion(current);

const target = bumpVersion(current, input);
parseVersion(target);

packageJson.version = target;
manifestJson.version = target;

writeFileSync(PACKAGE_PATH, `${JSON.stringify(packageJson, null, 2)}\n`);
writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifestJson, null, 2)}\n`);

console.log(`Updated version: ${current} -> ${target}`);
