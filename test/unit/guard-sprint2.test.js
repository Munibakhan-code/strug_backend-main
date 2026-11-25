import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanDropperTree, scanText } from '../../scripts/guard-malware.js';
import { scanPersistence } from '../../scripts/guard-persistence.js';
import { scanWorkflowText } from '../../scripts/guard-workflows.js';
import { scanLockfile } from '../../scripts/guard-lockfile.js';
import { verifyManifest } from '../../scripts/verify-test-manifest.js';
import { scanAssets } from '../../scripts/guard-assets.js';

const dirs = [];
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'strug-guard-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) {
    try { rmSync(dirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('sprint-2 guards', () => {
  it('flags PolinRider + ChainDrop markers in source text', () => {
    const g = 'global';
    expect(scanText(`${g}.i="x"`).length).toBeGreaterThan(0);
    expect(scanText('npm-cache' + '.com').some((m) => /ChainDrop/i.test(m))).toBe(true);
    expect(scanText('WEL1' + 'DROPPER').length).toBeGreaterThan(0);
  });

  it('flags a dropper filename in a synthetic tree', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'setup' + '.mjs'), 'console.log(1)\n');
    const hits = scanDropperTree(dir);
    expect(hits.some((h) => h.issues.includes('ChainDrop dropper filename'))).toBe(true);
  });

  it('flags VS Code folderOpen tasks', () => {
    const dir = tmp();
    mkdirSync(join(dir, '.vscode'));
    writeFileSync(
      join(dir, '.vscode', 'tasks.json'),
      JSON.stringify({ tasks: [{ runOn: 'folder' + 'Open', command: 'node' }] }),
    );
    const issues = scanPersistence(dir);
    expect(issues.some((i) => /folder open/i.test(i.reason))).toBe(true);
  });

  it('flags secret dumping in workflow YAML', () => {
    const yaml = ['run: echo ${{ ', 'toJSON', '(', 'secrets', ') }}'].join('');
    const found = scanWorkflowText(yaml, '.github/workflows/evil.yml');
    expect(found.some((i) => /dumps secrets/.test(i.reason))).toBe(true);
  });

  it('flags a denylisted version in a synthetic lockfile', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(
      join(dir, 'scripts', 'supply-chain-denylist.json'),
      JSON.stringify({ packages: { 'left-pad': ['0.0.0-evil'] }, preinstallAllowlist: [] }),
    );
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { preinstall: 'node ' + 'setup.mjs' } }),
    );
    writeFileSync(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        name: 'x',
        packages: {
          '': { version: '1.0.0' },
          'node_modules/left-pad': { version: '0.0.0-evil' },
        },
      }),
    );
    const issues = scanLockfile(dir);
    expect(issues.some((m) => /preinstall/.test(m))).toBe(true);
    expect(issues.some((m) => /left-pad@0\.0\.0-evil/.test(m))).toBe(true);
  });

  it('flags a text dropper hiding behind a .woff2 extension', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'public', 'fonts'), { recursive: true });
    const dropper = ['req', 'uire("./dropper")'].join('');
    writeFileSync(join(dir, 'public', 'fonts', 'fa-solid-400.woff2'), `${dropper}\n`);
    writeFileSync(join(dir, 'public', 'fonts', 'ok.woff2'), Buffer.from('wOF2xxxx'));
    const hits = scanAssets(dir);
    expect(hits.some((i) => i.file.endsWith('fa-solid-400.woff2'))).toBe(true);
    expect(hits.some((i) => i.file.endsWith('ok.woff2'))).toBe(false);
  });

  it('fails when a test file is missing from the manifest', () => {
    const result = verifyManifest(
      { verticals: { core: { tests: ['test/unit/authentication.test.js'] } } },
      ['test/unit/authentication.test.js', 'test/unit/brand-new.test.js'],
    );
    expect(result.orphans).toEqual(['test/unit/brand-new.test.js']);
  });
});
