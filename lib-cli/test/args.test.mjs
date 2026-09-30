import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, parseFlags } from '../args.mjs';

test('a flag takes the next token as its value unless that token is a flag', () => {
  assert.deepEqual(parseArgs(['rename', 'a', 'b', '--name', 'New Name', '--list']),
    { flags: { name: 'New Name', list: true }, positionals: ['rename', 'a', 'b'] });
  assert.deepEqual(parseFlags(['--a', '--b', 'x']), { a: true, b: 'x' });
});

test('--name=value is one token, and an empty value is kept', () => {
  assert.deepEqual(parseFlags(['--wake=2026-10-01', '--note=']), { wake: '2026-10-01', note: '' });
});

test('a repeated flag keeps its last value unless it is named in multi', () => {
  assert.deepEqual(parseFlags(['--x', '1', '--x', '2']), { x: '2' });
  assert.deepEqual(parseFlags(['--label', 'a', '--label=b', '--label'], { multi: ['label'] }), { label: ['a', 'b', true] });
});

test('a boolean flag never takes a value', () => {
  assert.deepEqual(parseArgs(['--inject', 'topic', '--skill', 'x'], { boolean: ['inject'] }),
    { flags: { inject: true, skill: 'x' }, positionals: ['topic'] });
});

test('a bare -- ends the flags, and the rest are positionals', () => {
  assert.deepEqual(parseArgs(['--a', '1', '--', '--b', 'c']), { flags: { a: '1' }, positionals: ['--b', 'c'] });
});

test('prototype keys are dropped and never reach the prototype', () => {
  const f = parseFlags(['--__proto__', 'x', '--constructor', 'y', '--toString', 'z']);
  assert.equal(Object.getPrototypeOf(f), Object.prototype);
  assert.equal(Object.hasOwn(f, '__proto__'), false);
  assert.equal(Object.hasOwn(f, 'constructor'), false);
  assert.equal(f.toString, 'z');
});

test('a single dash token is a positional, as gtg reads -h', () => {
  assert.deepEqual(parseArgs(['-h', '--x', '-1']), { flags: { x: '-1' }, positionals: ['-h'] });
});
