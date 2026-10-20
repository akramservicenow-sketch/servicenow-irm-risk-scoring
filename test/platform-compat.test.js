'use strict';

/**
 * Guards against syntax and APIs that are unsafe on older ServiceNow script engines.
 * Platform scripts must stay ES5 so they work in both compatibility mode and ES2021 mode.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SOURCES, ROOT } = require('../test-support/sn-runtime');

const FORBIDDEN = [
  [/\b(let|const)\s+[A-Za-z_$]/, 'let/const'],
  [/=>/, 'arrow function'],
  [/`/, 'template literal'],
  [/\bclass\s+[A-Za-z_$]/, 'class declaration'],
  [/\.\.\.[A-Za-z_$[]/, 'spread/rest'],
  [/\b(async|await)\s/, 'async/await'],
  [/\bObject\.(assign|entries|values)\s*\(/, 'ES2015+ Object API'],
  [/\b(Number\.isInteger|Array\.from)\s*\(/, 'ES2015+ API'],
  [/\.(includes|find|findIndex|padStart|startsWith|endsWith)\s*\(/, 'ES2015+ method'],
  [/\bgs\.(log|print)\s*\(/, 'gs.log/gs.print (not available in scoped apps)'],
  [/\bcurrent\.update\s*\(/, 'current.update()'],
  [/\beval\s*\(/, 'eval()'],
];

function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

for (const [key, rel] of Object.entries(SOURCES)) {
  test(`${rel} is ES5 and scoped-app safe`, () => {
    const code = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    for (const [re, label] of FORBIDDEN) {
      assert.ok(!re.test(code), `${rel} uses ${label}`);
    }
    if (key === 'core') {
      assert.ok(!/\b(GlideRecord|GlideDate|gs)\b\s*[.(]/.test(code), 'core must not use platform APIs');
    }
  });
}
