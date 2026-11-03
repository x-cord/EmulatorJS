// Load the served module and test its public emitter without constructing a player.
import assert from 'node:assert/strict';

globalThis.window = globalThis;
globalThis.document = {
    documentElement: { style: {} },
    addEventListener() {},
    removeEventListener() {},
    createElement() { return { style: {}, addEventListener() {}, removeEventListener() {} }; }
};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const { default: EmulatorJS } = await import('../data/emulator.min.js');
assert.equal(typeof EmulatorJS, 'function', 'loader.js requires a default-exported constructor');
const emulator = Object.create(EmulatorJS.prototype);
emulator.functions = {};
const calls = [];
let finish;
const pending = new Promise(resolve => { finish = resolve; });
const first = async () => { calls.push('first'); await pending; return 'ready'; };
const second = () => { calls.push('second'); return { reloading: true }; };
emulator.on('import', first);
emulator.on('import', second);
const emitting = emulator.callEventAsync('import', {});
assert.deepEqual(calls, ['first']);
finish();
assert.deepEqual(await emitting, ['ready', { reloading: true }]);
assert.deepEqual(calls, ['first', 'second']);
emulator.off('import', first);
assert.deepEqual(await emulator.callEventAsync('import', {}), [{ reloading: true }]);
emulator.on('failure', () => { throw new Error('snapshot commit failed'); });
await assert.rejects(emulator.callEventAsync('failure', {}), /snapshot commit failed/);
console.log('PASS served ES-module loader contract, awaited hooks, listener disposal and error propagation');
