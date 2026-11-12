'use strict';

/**
 * tests/helpers/task-queue-sources.js
 *
 * What the task-queue guards read, now that TaskQueue is assembled from more than one
 * file (WORK-TODO #10, B28, 2026-11-12). Before the split both guards read
 * lib/task-queue.js alone; a writer moved to another file would have left them reading
 * a file that no longer held it, and passing.
 *
 * Two independent enumerations, so neither has to be trusted on its own:
 *
 *   assemblyFiles()  - FROM DISK: lib/task-queue.js and every lib/task-queue-*.js.
 *                      A new part is covered the day it is created, without editing
 *                      a list.
 *   methodSources()  - FROM THE CLASS: every method on TaskQueue.prototype, by its own
 *                      source text (Function.prototype.toString), wherever it was
 *                      defined. A method mixed in from a file no one thought to list
 *                      is still read.
 *
 * unlocated() joins the two: a prototype method that no assembly file defines (by a
 * function header carrying its name) is reported, so "the files we scan" and "the code
 * the class runs" cannot drift apart unnoticed. It matches by NAME, not by source text:
 * under jest, babel-jest transforms every required module, so a method's toString() is
 * the transformed text and is not a substring of the file on disk.
 */

const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '..', '..', 'lib');

/**
 * Every file the task queue is assembled from, enumerated from disk.
 * @param {string} [libDir] - Override for the negative controls.
 * @returns {{ rel: string, abs: string, source: string }[]}
 */
function assemblyFiles(libDir = LIB) {
    return fs.readdirSync(libDir)
        .filter((name) => name === 'task-queue.js' || /^task-queue-[a-z0-9-]+\.js$/.test(name))
        .sort()
        .map((name) => {
            const abs = path.join(libDir, name);
            return { rel: `lib/${name}`, abs, source: fs.readFileSync(abs, 'utf8') };
        });
}

/**
 * Every method on a class prototype with its own source text.
 * @param {Function} Klass
 * @returns {{ name: string, source: string }[]}
 */
function methodSources(Klass) {
    return Object.getOwnPropertyNames(Klass.prototype)
        .filter((name) => name !== 'constructor' && typeof Klass.prototype[name] === 'function')
        .sort()
        .map((name) => ({ name, source: Klass.prototype[name].toString() }));
}

/**
 * Methods that no file defines: no line in any file is a function header carrying the
 * method's name (a class or object-literal method, or a `function` declaration).
 * @param {{ name: string }[]} methods
 * @param {{ source: string }[]} files
 * @returns {string[]} method names
 */
function unlocated(methods, files) {
    const defines = (src, name) => new RegExp(
        `^\\s*(?:async\\s+)?(?:function\\s*)?${name.replace(/\$/g, '\\$')}\\s*\\([^)]*\\)\\s*\\{\\s*$`, 'm'
    ).test(src);
    return methods.filter((m) => !files.some((f) => defines(f.source, m.name))).map((m) => m.name);
}

/**
 * PM2-naming string literals the given files WRITE (tests/task-queue-lifecycle.test.js).
 * Comments may name PM2 (lib/task-queue.js's header documents its removal), so they are
 * stripped first.
 * @param {{ rel: string, source: string }[]} files
 * @returns {string[]} `<file>: <literal>` per offending literal
 */
function pm2Literals(files) {
    return files.flatMap((f) => {
        const stripped = f.source
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
        const literals = stripped.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) || [];
        return literals.filter((l) => /pm2/i.test(l)).map((l) => `${f.rel}: ${l}`);
    });
}

module.exports = { assemblyFiles, methodSources, unlocated, pm2Literals, LIB };
