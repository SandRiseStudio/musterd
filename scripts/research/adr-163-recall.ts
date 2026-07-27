/**
 * ADR 163 recall arm — measure isWriteShaped() recall against EMPIRICAL ground truth.
 *
 * Ground truth is not asserted. Each command runs in a fresh sandbox and we hash the tree before and
 * after; if the tree changed, the command wrote. That way a corpus entry cannot be mislabelled by my
 * own belief about what a command does, which is the same class of error that confounded Gate B.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { isWriteShaped } from '../../packages/protocol/dist/enforcement.js';

type Entry = { command: string; note?: string };

/** Executed for real in a sandbox. Ground truth measured. */
const EXECUTED: Entry[] = [
  // --- positive controls: the shapes ADR 163 claims to catch ---
  { command: 'echo hi > out.txt' },
  { command: 'echo hi >> out.txt' },
  { command: 'echo hi | tee out.txt' },
  { command: "sed -i '' s/a/b/ seed.txt" },
  { command: 'rm seed.txt' },
  { command: 'mv seed.txt moved.txt' },
  { command: 'cp seed.txt copy.txt' },
  { command: 'mkdir -p newdir' },
  { command: 'touch fresh.txt' },
  { command: 'truncate -s 0 seed.txt' },
  { command: 'chmod 600 seed.txt', note: 'metadata-only: content hash will not change' },
  { command: 'ln -s seed.txt link.txt' },
  { command: 'patch -p0 < seed.patch' },

  // --- the indirection paths: writes a real agent absolutely does make ---
  { command: 'python3 -c \'open("py.txt","w").write("x")\'' },
  { command: 'python3 write_it.py' },
  { command: 'node -e \'require("fs").writeFileSync("node.txt","x")\'' },
  { command: 'node build.js' },
  { command: 'cat > heredoc.txt <<EOF\nhello\nEOF' },
  { command: 'cat <<EOF > heredoc2.txt\nhello\nEOF' },
  { command: 'tar -xf bundle.tar' },
  { command: 'unzip -o bundle.zip' },
  { command: "awk '{print}' seed.txt > awk.txt" },
  { command: 'sort seed.txt -o sorted.txt', note: 'in-place via -o, no redirect' },
  { command: 'install -m 644 seed.txt installed.txt' },
  { command: 'rsync seed.txt rsynced.txt' },
  { command: 'ex -sc "wq" seed.txt', note: 'editor in batch mode' },
  { command: 'sh -c "echo x > wrapped.txt"', note: 'redirect nested inside a wrapper' },
  { command: 'bash script.sh' },
  { command: 'make out.made', note: 'build tool lands an artifact' },
  { command: 'xargs touch < names.txt' },
  { command: 'cp -r subdir subdir_copy' },
  { command: 'dd if=seed.txt of=dd.txt bs=1', note: 'sandboxed dd, files only' },

  // --- true negatives: reads must never fire ---
  { command: 'cat seed.txt' },
  { command: 'ls -la' },
  { command: 'grep -rn hello .' },
  { command: 'wc -l seed.txt' },
  { command: 'head -5 seed.txt' },
  { command: 'diff seed.txt copy.txt || true' },
  { command: 'find . -name "*.txt"' },
  { command: "awk '{print}' seed.txt", note: 'same tool as a write above, no redirect' },
  { command: 'sort seed.txt', note: 'same tool as a write above, no -o' },
  { command: 'python3 -c \'print(open("seed.txt").read())\'', note: 'python that only reads' },
  { command: "node -e 'console.log(1)'", note: 'node that only reads' },
  { command: 'git status' },
  { command: 'git log --oneline' },
  { command: 'git diff' },
];

/** NOT executed: outward-facing or environment-mutating. Labelled by inspection, reported separately. */
const INSPECTED: Array<Entry & { writes: boolean }> = [
  { command: 'git push origin main', writes: true, note: 'outward — never executed in a probe' },
  { command: 'npm publish', writes: true, note: 'outward — never executed in a probe' },
  { command: 'pnpm install', writes: true, note: 'network + mutates node_modules' },
  { command: 'git commit -m x', writes: true, note: 'mutates repo history' },
  { command: 'gh pr create --title x --body y', writes: true, note: 'outward' },
  { command: 'curl -X POST https://example.com/api -d @f', writes: true, note: 'outward write' },
  { command: 'curl -o out.bin https://example.com/f', writes: true, note: 'network fetch to disk' },
  { command: 'ssh host "rm -rf /tmp/x"', writes: true, note: 'write on another machine' },
  {
    command: 'docker run -v $PWD:/w img sh -c "echo x > /w/f"',
    writes: true,
    note: 'via container',
  },
];

function hashTree(dir: string): string {
  const parts: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) {
        parts.push(`D ${relative(dir, p)}`);
        walk(p);
      } else if (st.isSymbolicLink()) {
        parts.push(`L ${relative(dir, p)}`);
      } else {
        // Mode is part of the state: `chmod` is a real write and a content-only hash cannot see it.
        parts.push(
          `F ${relative(dir, p)} ${(st.mode & 0o7777).toString(8)} ${createHash('sha1').update(readFileSync(p)).digest('hex')}`,
        );
      }
    }
  };
  walk(dir);
  return createHash('sha1').update(parts.join('\n')).digest('hex');
}

function seed(dir: string) {
  writeFileSync(join(dir, 'seed.txt'), 'a\nhello\n');
  // DELIBERATELY different from seed.txt: if the two matched, `cp seed.txt copy.txt` would be a real
  // no-op and the tree hash would score a genuine write as a non-write. That bug was in the first run.
  writeFileSync(join(dir, 'copy.txt'), 'different\n');
  writeFileSync(join(dir, 'names.txt'), 'n1.txt\nn2.txt\n');
  writeFileSync(join(dir, 'write_it.py'), 'open("frompy.txt","w").write("x")\n');
  writeFileSync(join(dir, 'build.js'), 'require("fs").writeFileSync("built.txt","x")\n');
  writeFileSync(join(dir, 'script.sh'), 'echo x > fromsh.txt\n');
  writeFileSync(
    join(dir, 'seed.patch'),
    '--- seed.txt\n+++ seed.txt\n@@ -1,2 +1,2 @@\n-a\n+b\n hello\n',
  );
  writeFileSync(join(dir, 'Makefile'), 'out.made:\n\techo made > out.made\n');
  execFileSync('mkdir', ['-p', join(dir, 'subdir')]);
  writeFileSync(join(dir, 'subdir', 'inner.txt'), 'x\n');
  // The archives must contain a member that is NOT already on disk, else extraction is a no-op and the
  // ground truth is wrong in the same way the cp case was.
  const staging = join(dir, '.staging');
  execFileSync('mkdir', ['-p', staging]);
  writeFileSync(join(staging, 'extracted.txt'), 'from-archive\n');
  execFileSync('tar', ['-cf', join(dir, 'bundle.tar'), '-C', staging, 'extracted.txt']);
  execFileSync('zip', ['-qj', join(dir, 'bundle.zip'), join(staging, 'extracted.txt')]);
  rmSync(staging, { recursive: true, force: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
}

type Row = { command: string; wrote: boolean; detected: boolean; note?: string; ran: boolean };
const rows: Row[] = [];

for (const entry of EXECUTED) {
  const dir = mkdtempSync(join(tmpdir(), 'adr163-recall-'));
  try {
    seed(dir);
    const before = hashTree(dir);
    let ran = true;
    try {
      execFileSync('/bin/bash', ['-c', entry.command], {
        cwd: dir,
        stdio: 'ignore',
        timeout: 15_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch {
      ran = false; // non-zero exit; the tree diff still tells us whether it wrote before failing
    }
    const wrote = hashTree(dir) !== before;
    rows.push({
      command: entry.command,
      wrote,
      detected: isWriteShaped({ tool: 'Bash', command: entry.command }),
      note: entry.note,
      ran,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const writes = rows.filter((r) => r.wrote);
const reads = rows.filter((r) => !r.wrote);
const caught = writes.filter((r) => r.detected);
const missed = writes.filter((r) => !r.detected);
const falsePos = reads.filter((r) => r.detected);

const insCaught = INSPECTED.filter((e) => isWriteShaped({ tool: 'Bash', command: e.command }));

console.log('=== EXECUTED corpus (ground truth measured by tree hash) ===');
for (const r of rows) {
  const verdict = r.wrote === r.detected ? '   ' : r.wrote ? 'MISS' : 'FP  ';
  console.log(
    `${verdict} wrote=${r.wrote ? 'Y' : 'n'} detected=${r.detected ? 'Y' : 'n'}${r.ran ? '' : ' (exit≠0)'}  ${r.command.replace(/\n/g, '\\n')}${r.note ? `   # ${r.note}` : ''}`,
  );
}

console.log('\n=== NOT EXECUTED (labelled by inspection; outward or env-mutating) ===');
for (const e of INSPECTED) {
  const d = isWriteShaped({ tool: 'Bash', command: e.command });
  console.log(`${d ? '    ' : 'MISS'} detected=${d ? 'Y' : 'n'}  ${e.command}   # ${e.note}`);
}

console.log('\n=== RESULT ===');
console.log(`executed:            ${rows.length}`);
console.log(`actual writes:       ${writes.length}`);
console.log(`  caught:            ${caught.length}`);
console.log(`  missed:            ${missed.length}`);
console.log(
  `RECALL (executed):   ${caught.length}/${writes.length} = ${((100 * caught.length) / writes.length).toFixed(1)}%`,
);
console.log(`actual non-writes:   ${reads.length}`);
console.log(
  `  false positives:   ${falsePos.length}${falsePos.length ? ` -> ${falsePos.map((r) => r.command).join(' | ')}` : ''}`,
);
console.log(
  `RECALL (inspected):  ${insCaught.length}/${INSPECTED.length} = ${((100 * insCaught.length) / INSPECTED.length).toFixed(1)}%`,
);
const allW = writes.length + INSPECTED.length;
const allC = caught.length + insCaught.length;
console.log(`RECALL (combined):   ${allC}/${allW} = ${((100 * allC) / allW).toFixed(1)}%`);
console.log('\nMISSES (executed):');
for (const r of missed) console.log(`  - ${r.command.replace(/\n/g, '\\n')}`);
