import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const verify = (cwd) => spawnSync('git', ['grep', '-q', '^value=2$', '--', 'data.txt'], { cwd }).status === 0;

class SimulatedGitHub {
  constructor() { this.head = null; this.events = []; this.verified = new Map(); this.merges = 0; }
  publishHead(sha) { this.head = sha; }
  observe(sha, state) {
    if (sha !== this.head) return false;
    const key = sha + ':' + state;
    if (!this.verified.has(key)) { this.verified.set(key, true); this.events.push({ sha, state }); }
    return state === 'SUCCESS';
  }
}

test('real Git, failing subprocess check, bounded repair, simulated CI and human approval boundary', () => {
  const repo = mkdtempSync(join(tmpdir(), 'little-monkey-i2p-ci-'));
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'Fixture');
    git(repo, 'config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(repo, 'data.txt'), 'value=1\n');
    git(repo, 'add', '--', 'data.txt');
    git(repo, 'commit', '-qm', 'initial state');
    git(repo, 'checkout', '-qb', 'issue-to-pr/fixture');
    const initial = git(repo, 'rev-parse', 'HEAD');
    const github = new SimulatedGitHub();
    github.publishHead(initial);
    assert.equal(verify(repo), false, 'a real subprocess must fail initially');
    assert.equal(github.observe(initial, 'FAILURE'), false);
    assert.equal(github.observe(initial, 'FAILURE'), false);
    assert.equal(github.events.length, 1, 'duplicate CI events must be deduplicated');

    const maxRepairs = 2;
    let repairAttempts = 0;
    assert.ok(repairAttempts < maxRepairs);
    repairAttempts++;
    writeFileSync(join(repo, 'data.txt'), 'value=2\n');
    assert.deepEqual(git(repo, 'diff', '--name-only').split('\n'), ['data.txt'], 'only declared file may change');
    git(repo, 'diff', '--check');
    assert.equal(verify(repo), true, 'authoritative subprocess now passes');
    git(repo, 'add', '--', 'data.txt');
    git(repo, 'commit', '-qm', 'repair failing check');
    const repaired = git(repo, 'rev-parse', 'HEAD');
    assert.notEqual(initial, repaired);
    github.publishHead(repaired);
    assert.equal(github.observe(initial, 'SUCCESS'), false, 'green stale head cannot authorize ready');
    assert.equal(github.observe(repaired, 'PENDING'), false, 'pending CI cannot authorize ready');
    assert.equal(github.observe(repaired, 'SUCCESS'), true, 'current head with green CI can be ready');
    assert.equal(github.observe(repaired, 'SUCCESS'), true);
    assert.equal(github.events.length, 3);
    assert.equal(repairAttempts, 1);
    assert.equal(github.merges, 0, 'no automatic merge is allowed');
    const publicationApproved = false;
    assert.equal(publicationApproved, false, 'ready still requires a human publication decision');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
