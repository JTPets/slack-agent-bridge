/**
 * tests/no-shell-execution.test.js
 *
 * THE enumerating guard for the command-injection class. This file is the
 * executable form of the claim "no shell-string execution remains in this repo" —
 * cite it, not a number, when that claim is made.
 *
 * LOGIC CHANGE 2026-09-14: New file. The previous anti-reappearance test lived in
 * tests/clone-lifecycle.test.js and read only the body of `cloneRepo`. That scope
 * is exactly as wide as the one function the 2026-09-14 security review happened to
 * name: a new `execSync(`git ${dir}`)` in lib/watercooler.js, in bots/storefront.js,
 * or three lines below cloneRepo in the same file, all passed it. A guard scoped to
 * the site of the last bug is not a class guard.
 *
 * What is scanned: every non-test JavaScript file in the repo (entry points, lib/,
 * bots/, scripts/, memory/, lib/integrations/) — enumerated from disk, so a new
 * file or a new directory is covered the moment it is added rather than when
 * somebody remembers to list it here.
 *
 * What is banned, and why each is a shell and not merely a style preference:
 *   - `exec(` / `execSync(` / `execFile*(..., {shell: ...})` — child_process.exec
 *     and execSync hand their first argument to /bin/sh -c. Every metacharacter in
 *     an interpolated value is then syntax.
 *   - `shell: true` on spawn/spawnSync/execFile — the same /bin/sh, opted into.
 *   - destructuring `exec` or `execSync` off child_process — an unused import of a
 *     shell API is the next shell call's missing half (see bridge-agent.js, which
 *     carried a dead `execSync` import for exactly this reason).
 *
 * What is allowed: spawn, spawnSync, execFileSync and execFile with an argv array
 * and no `shell` option. Those never involve a shell (CLAUDE.md, "Child Process
 * Safety").
 *
 * Comments and the contents of string/template literals are stripped before
 * scanning, so prose that NAMES a banned API — including this file's own module
 * header, and every LOGIC CHANGE comment explaining why one was removed — does not
 * trip it. Only real code does.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

const SKIP_DIRS = new Set(['node_modules', '.git', 'tests', 'coverage', 'public', '.claude-home']);

/**
 * Every non-test .js file in the repo, enumerated from disk.
 *
 * This walk IS the regeneration command for "which files does the class cover".
 * Run it standalone with:
 *   node -e "console.log(require('./tests/no-shell-execution.test.js'))"  // not exported; use jest
 * or reproduce it from the shell with:
 *   find . -name '*.js' -not -path './node_modules/*' -not -path './.git/*' \
 *          -not -path './tests/*' -not -path './coverage/*' | sort
 *
 * @param {string} dir
 * @param {string[]} [out]
 * @returns {string[]} Absolute paths.
 */
function listSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      listSourceFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Blank out comments and, optionally, string/template literal CONTENTS — preserving
 * offsets and line structure so a reported match still points at real code.
 *
 * Written as a small character scanner rather than a regex because a regex that
 * tries to tell a string from a comment from a division operator gets this wrong
 * in ways that make the guard either blind or permanently red.
 *
 * Two derived forms are needed and they are not interchangeable:
 *   - CALL-SITE bans scan with strings blanked, so a comment or message text that
 *     merely names a banned API does not trip the guard.
 *   - The child_process IMPORT check scans with strings intact, because the module
 *     name it must recognise IS a string literal. Blanking it made the check match
 *     nothing and pass on every file — which it silently did until a negative
 *     control (re-adding bridge-agent.js's dead `execSync` import) failed to go red.
 *
 * @param {string} src
 * @param {{ blankStrings?: boolean }} [opts]
 * @returns {string}
 */
function stripCommentsAndStrings(src, { blankStrings = true } = {}) {
  const out = Array.from(src);
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === quote) break;
        j += 1;
      }
      // Blank the contents, keep the delimiters so the code still tokenises.
      if (blankStrings) blank(i + 1, Math.min(j, src.length));
      i = Math.min(j + 1, src.length);
      continue;
    }
    i += 1;
  }
  return out.join('');
}

const BANNED = [
  {
    label: 'execSync() — executes a /bin/sh command string',
    pattern: /\bexecSync\s*\(/,
  },
  {
    label: 'exec() — executes a /bin/sh command string',
    // \b...exec immediately followed by "(" — execFile/execFileSync/execCommand
    // do not match, because those have characters between "exec" and "(".
    pattern: /(?<![.\w])exec\s*\(/,
  },
  {
    label: 'shell: true — opts a spawn back into /bin/sh',
    pattern: /shell\s*:\s*true/,
  },
];

// The require itself is fine; destructuring `exec` or `execSync` out of it is not.
const CHILD_PROCESS_DESTRUCTURE =
  /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]child_process['"]\s*\)/g;
const SHELL_API_NAMES = /\b(exec|execSync)\b/;

const sourceFiles = listSourceFiles(REPO_ROOT);

describe('no shell-string execution anywhere in the repo', () => {
  test('the scan covers a non-trivial set of files, including lib/ and the entry points', () => {
    // A guard that silently scanned zero files would pass forever. Pin the floor.
    const rel = sourceFiles.map((f) => path.relative(REPO_ROOT, f));
    expect(rel.length).toBeGreaterThan(20);
    expect(rel).toContain('bridge-agent.js');
    expect(rel).toContain('auto-update.js');
    expect(rel).toContain('security-review.js');
    expect(rel).toContain(path.join('lib', 'clone-lifecycle.js'));
    expect(rel).toContain(path.join('lib', 'integrations', 'gmail.js'));
    expect(rel).toContain(path.join('bots', 'storefront.js'));
    // Every lib/ module is in the scan, enumerated from disk rather than listed.
    const libCount = rel.filter((f) => f.startsWith(`lib${path.sep}`)).length;
    expect(libCount).toBeGreaterThan(20);
  });

  test.each(sourceFiles.map((f) => [path.relative(REPO_ROOT, f), f]))(
    '%s contains no shell-string execution',
    (_rel, file) => {
      const code = stripCommentsAndStrings(fs.readFileSync(file, 'utf8'));

      for (const rule of BANNED) {
        const match = code.match(rule.pattern);
        if (match) {
          const line = code.slice(0, match.index).split('\n').length;
          throw new Error(
            `${path.relative(REPO_ROOT, file)}:${line} uses ${rule.label}. ` +
              'Use spawn/spawnSync/execFileSync with an argv array instead ' +
              '(CLAUDE.md, "Child Process Safety").'
          );
        }
      }
    }
  );

  test.each(sourceFiles.map((f) => [path.relative(REPO_ROOT, f), f]))(
    '%s does not import exec or execSync from child_process',
    (_rel, file) => {
      // Strings are kept here: 'child_process' is the literal being matched.
      const code = stripCommentsAndStrings(fs.readFileSync(file, 'utf8'), {
        blankStrings: false,
      });
      const re = new RegExp(CHILD_PROCESS_DESTRUCTURE.source, 'g');
      const imported = [];
      let m = re.exec(code);
      while (m) {
        imported.push(...m[1].split(',').map((n) => n.trim()).filter(Boolean));
        m = re.exec(code);
      }
      const shellApis = imported.filter((n) => SHELL_API_NAMES.test(n));
      if (shellApis.length > 0) {
        throw new Error(
          `${path.relative(REPO_ROOT, file)} imports ${shellApis.join(', ')} from ` +
            'child_process. An unused shell import is the next shell call\'s missing ' +
            'half — import spawn/spawnSync/execFileSync instead, or drop the import.'
        );
      }
    }
  );
});

describe('the guard itself detects what it claims to', () => {
  // A scanner that strips too much is a guard that passes on everything. These
  // exercise the stripper against the shapes that actually occur in this repo.
  test('flags a shell call in ordinary code', () => {
    const code = stripCommentsAndStrings("const out = execSync(`git status ${dir}`);");
    expect(code).toMatch(/\bexecSync\s*\(/);
  });

  test('flags exec() but not execFileSync() or a method named execCommand()', () => {
    const banned = BANNED.find((r) => r.label.startsWith('exec()')).pattern;
    expect(stripCommentsAndStrings('exec(cmd);')).toMatch(banned);
    expect(stripCommentsAndStrings('execFileSync("git", args);')).not.toMatch(banned);
    expect(stripCommentsAndStrings('await execCommand("git", args);')).not.toMatch(banned);
    expect(stripCommentsAndStrings('re.exec(code);')).not.toMatch(banned);
  });

  test('does NOT flag a comment or a string that merely names a banned API', () => {
    const code = stripCommentsAndStrings(
      ['// never use execSync( here', 'const msg = "execSync( is banned";', 'const x = 1;'].join(
        '\n'
      )
    );
    expect(code).not.toMatch(/\bexecSync\s*\(/);
    expect(code).toContain('const x = 1;');
  });

  test('flags shell: true on an otherwise safe spawn', () => {
    const code = stripCommentsAndStrings('spawnSync("git", args, { shell: true });');
    expect(code).toMatch(/shell\s*:\s*true/);
  });

  test('the import check sees the module name (strings must NOT be blanked for it)', () => {
    // Regression: the first version of this file blanked string contents before the
    // import scan, so `require('child_process')` became `require('             ')`,
    // the regex matched nothing, and every file passed. The negative control caught
    // it; this pins it.
    const src = "const { execSync } = require('child_process');";
    const kept = stripCommentsAndStrings(src, { blankStrings: false });
    expect(kept).toContain("require('child_process')");
    const re = new RegExp(CHILD_PROCESS_DESTRUCTURE.source, 'g');
    const m = re.exec(kept);
    expect(m).not.toBeNull();
    expect(m[1]).toMatch(SHELL_API_NAMES);

    // ...and the blanked form, used for call-site bans, does NOT see it.
    const blanked = stripCommentsAndStrings(src);
    expect(new RegExp(CHILD_PROCESS_DESTRUCTURE.source).exec(blanked)).toBeNull();
  });

  test('the import check allows the safe APIs', () => {
    const src = "const { spawn, spawnSync, execFileSync } = require('child_process');";
    const kept = stripCommentsAndStrings(src, { blankStrings: false });
    const m = new RegExp(CHILD_PROCESS_DESTRUCTURE.source).exec(kept);
    expect(m).not.toBeNull();
    const names = m[1].split(',').map((n) => n.trim());
    expect(names.filter((n) => SHELL_API_NAMES.test(n))).toEqual([]);
  });

  test('preserves line numbers so a failure points at real code', () => {
    const src = ['/* a\n   multi-line\n   comment */', 'execSync(x);'].join('\n');
    const code = stripCommentsAndStrings(src);
    const idx = code.match(/\bexecSync\s*\(/).index;
    expect(code.slice(0, idx).split('\n').length).toBe(4);
  });
});
