import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';
import { NativeSave } from '../data/src/native-save.js';
import { EJS_GameManager } from '../data/src/GameManager.js';

function fixture(t, core = 'ppsspp') {
  const root = fs.mkdtempSync(join(tmpdir(), 'emulatorjs-save-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const path = name => join(root, name);
  const calls = [];
  const events = {};
  const emulator = {
    saveFileExt: core === 'gambatte' ? 'srm' : false,
    paused: false,
    getCore: () => core,
    getBaseFileName: () => 'fixture',
    pause() { calls.push('pause'); this.paused = true; },
    play() { calls.push('play'); this.paused = false; },
    on(name, callback) { (events[name] ||= []).push(callback); },
    callEvent() {},
    async callEventAsync(name, operation) {
      const results = [];
      for (const callback of events[name] || []) results.push(await callback(operation));
      return results;
    },
  };
  const gm = Object.create(EJS_GameManager.prototype);
  Object.assign(gm, { EJS: emulator, Module: {}, FS: {
    analyzePath: name => ({ exists: fs.existsSync(path(name)) }),
    lstat: name => fs.lstatSync(path(name)),
    isDir: mode => (mode & 0xf000) === 0x4000,
    isFile: mode => (mode & 0xf000) === 0x8000,
    readdir: name => fs.readdirSync(path(name)),
    readFile: name => new Uint8Array(fs.readFileSync(path(name))),
    writeFile: (name, bytes) => fs.writeFileSync(path(name), new Uint8Array(bytes)),
    mkdirTree: name => fs.mkdirSync(path(name), { recursive: true }),
    unlink: name => fs.unlinkSync(path(name)),
    rmdir: name => fs.rmdirSync(path(name)),
    syncfs: (populate, callback) => { assert.equal(populate, false); calls.push('sync'); callback(null); },
  }, functions: {
    getSaveFilePath: () => '/data/saves/fixture.srm',
    saveSaveFiles: () => calls.push('capture'),
    loadSaveFiles: () => calls.push('refresh SRAM'),
  } });
  gm.nativeSave = new NativeSave(gm);
  const put = (name, bytes) => { gm.FS.mkdirTree(dirname(name)); gm.FS.writeFile(name, bytes); };
  const get = name => [...gm.FS.readFile(name)];
  return { gm, calls, put, get, emulator };
}
async function zip(files, level = 0) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level });
  for (const [name, bytes] of Object.entries(files)) await writer.add(name, new Uint8ArrayReader(new Uint8Array(bytes)));
  return new Blob([await writer.close()]);
}
const root = '/data/saves/PSP/SAVEDATA';

function nativeDevice(gm, calls, put) {
  const path = '/data/saves/core-owned/device.nv';
  gm.Module = {
    _ejs_native_save_path: () => 1,
    UTF8ToString: () => path,
    HEAPU8: new Uint8Array(2048),
    _malloc: () => 16,
    _free() { calls.push('free validation bytes'); },
    _ejs_validate_native_save(pointer, size) { assert.equal(pointer, 16); return size === 3; },
    _ejs_flush_native_save() { calls.push('flush device'); put(path, [1, 2, 3]); return 1; },
    _ejs_load_native_save() { calls.push('refresh device'); return 1; },
  };
  return path;
}

test('native capabilities come from the core or core profile, without game-slug detection', t => {
  const { gm, calls, put } = fixture(t, 'mame2003_plus');
  assert.equal(gm.supportsNativeSave(), false);
  nativeDevice(gm, calls, put);
  assert.equal(gm.supportsNativeSave(), true);
  assert.equal(gm.nativeSave.descriptor.path, '/data/saves/core-owned/device.nv');
});

test('a core can advertise cartridge save memory even when its package disables legacy saves', t => {
  const { gm } = fixture(t, 'mame2003_plus');
  assert.equal(gm.supportsNativeSave(), false);
  gm.Module._ejs_save_memory_size = () => 1024;
  assert.equal(gm.supportsNativeSave(), true);
  assert.equal(gm.nativeSave.descriptor.source, 'retroarch');
  gm.Module._ejs_save_memory_size = () => 0;
  assert.equal(gm.supportsNativeSave(), false);
});

test('native save APIs reject calls before the core starts without querying native pointers', async t => {
  const { gm, emulator } = fixture(t);
  emulator.started = false;
  gm.Module._ejs_native_save_path = () => { throw new Error('must not query'); };
  assert.equal(gm.supportsNativeSave(), false);
  await assert.rejects(gm.flushSaveData(), /not-started/);
  await assert.rejects(gm.exportSaveData(), /unsupported/);
});

test('native raw files are flushed, exported, validated by the core, refreshed and committed', async t => {
  const { gm, calls, put, get, emulator } = fixture(t, 'mame2003_plus');
  const path = nativeDevice(gm, calls, put);
  const exported = await gm.exportSaveData();
  assert.equal(exported.filename, 'device.nv');
  assert.deepEqual([...exported.save], [1, 2, 3]);
  assert.deepEqual(calls, ['pause', 'flush device', 'capture', 'sync', 'play']);
  emulator.on('beforeSaveDataImport', () => calls.push('before import'));
  emulator.on('saveDataImportCommit', () => {
    assert.deepEqual(get(path), [7, 8, 9]);
    assert.equal(calls.at(-1), 'refresh device');
    calls.push('clear host snapshot');
  });
  await gm.importSaveData(new Blob([new Uint8Array([7, 8, 9])]));
  assert.deepEqual(get(path), [7, 8, 9]);
  assert.equal(emulator.paused, false);
});

test('invalid raw data leaves native files intact and releases the host import lifecycle', async t => {
  const { gm, calls, put, get, emulator } = fixture(t, 'mame2003_plus');
  const path = nativeDevice(gm, calls, put);
  put(path, [1, 2, 3]);
  emulator.on('beforeSaveDataImport', () => calls.push('before import'));
  emulator.on('saveDataImportCommit', () => { throw new Error('must not commit'); });
  emulator.on('afterSaveDataImport', operation => { assert.equal(operation.success, false); calls.push('after failed import'); });
  await assert.rejects(gm.importSaveData(new Blob([new Uint8Array([7])])), /invalid/);
  assert.deepEqual(get(path), [1, 2, 3]);
  assert.deepEqual(calls, ['pause', 'before import', 'free validation bytes', 'after failed import', 'play']);
});

test('PSP ZIP round trip includes native files and excludes settings and savestates', async t => {
  const { gm, put, get } = fixture(t);
  put(`${root}/ULJS001/DATA.BIN`, [1, 2, 3]);
  put(`${root}/ULJS001/PARAM.SFO`, [4, 5]);
  put('/data/saves/PSP/SYSTEM/ppsspp.ini', [6]);
  put('/data/saves/PSP/PPSSPP_STATE/game.ppst', [7]);
  const result = await gm.exportSaveData();
  assert.equal(result.filename, 'fixture-save-data.zip');
  put(`${root}/ULJS001/DATA.BIN`, [99]);
  await gm.importSaveData(new Blob([result.save]));
  assert.deepEqual(get(`${root}/ULJS001/DATA.BIN`), [1, 2, 3]);
  assert.deepEqual(get('/data/saves/PSP/SYSTEM/ppsspp.ini'), [6]);
  assert.deepEqual(get('/data/saves/PSP/PPSSPP_STATE/game.ppst'), [7]);
});

test('PSP import replaces only included folders and awaits host commit after persistence', async t => {
  const { gm, calls, put, get, emulator } = fixture(t);
  put(`${root}/ULJS001/old.bin`, [1]);
  put(`${root}/OTHERGAME/DATA.BIN`, [2]);
  emulator.on('saveDataImportCommit', () => calls.push('clear host snapshot'));
  await gm.importSaveData(await zip({ 'PSP/SAVEDATA/ULJS001/DATA.BIN': [99] }));
  assert.equal(gm.FS.analyzePath(`${root}/ULJS001/old.bin`).exists, false);
  assert.deepEqual(get(`${root}/ULJS001/DATA.BIN`), [99]);
  assert.deepEqual(get(`${root}/OTHERGAME/DATA.BIN`), [2]);
  assert.deepEqual(calls, ['pause', 'capture', 'sync', 'sync', 'clear host snapshot', 'play']);
});

test('failed storage commit rolls native files back without clearing the host snapshot', async t => {
  const { gm, put, get, emulator } = fixture(t);
  put(`${root}/ULJS001/old.bin`, [1]);
  let syncs = 0, cleared = false;
  gm.FS.syncfs = (_, callback) => callback(++syncs === 2 ? new Error('disk full') : null);
  emulator.on('saveDataImportCommit', () => { cleared = true; });
  await assert.rejects(gm.importSaveData(await zip({ 'PSP/SAVEDATA/ULJS001/DATA.BIN': [99] })), /disk full/);
  assert.deepEqual(get(`${root}/ULJS001/old.bin`), [1]);
  assert.equal(gm.FS.analyzePath(`${root}/ULJS001/DATA.BIN`).exists, false);
  assert.equal(cleared, false);
});

test('host commit failure rolls native files back, refreshes the device, and releases the lifecycle', async t => {
  const { gm, calls, put, get, emulator } = fixture(t, 'mame2003_plus');
  const path = nativeDevice(gm, calls, put);
  let operation;
  emulator.on('beforeSaveDataImport', value => { operation = value; });
  emulator.on('saveDataImportCommit', () => { throw new Error('snapshot storage failed'); });
  emulator.on('afterSaveDataImport', value => { assert.equal(value, operation); assert.equal(value.success, false); });
  await assert.rejects(gm.importSaveData(new Blob([new Uint8Array([7, 8, 9])])), /snapshot storage failed/);
  assert.deepEqual(get(path), [1, 2, 3]);
  assert.equal(calls.filter(call => call === 'refresh device').length, 2);
  assert.equal(emulator.paused, false);
});

test('a host can cold-reload after import without resuming the outgoing core', async t => {
  const { gm, emulator } = fixture(t);
  emulator.on('afterSaveDataImport', value => { assert.equal(value.success, true); return { reloading: true }; });
  await gm.importSaveData(await zip({ 'PSP/SAVEDATA/GAME/DATA.BIN': [1] }));
  assert.equal(emulator.paused, true);
});

test('periodic flushes cannot overwrite files during an import commit', async t => {
  const { gm, calls } = fixture(t);
  gm.FS.syncfs = (_, callback) => {
    if (gm.nativeSave.writing) {
      const before = calls.length;
      gm.saveSaveFiles();
      assert.equal(calls.length, before);
    }
    callback(null);
  };
  await gm.importSaveData(await zip({ 'PSP/SAVEDATA/GAME/DATA.BIN': [1] }));
});

test('ordinary cartridge SRAM uses the same validated import lifecycle', async t => {
  const { gm, put, get, calls } = fixture(t, 'gambatte');
  put('/data/saves/fixture.srm', [1]);
  await gm.importSaveData(new Blob([new Uint8Array([99])]));
  assert.deepEqual(get('/data/saves/fixture.srm'), [99]);
  assert.ok(calls.includes('refresh SRAM'));
});

test('archives reject unrelated and traversing entries, conflicts and oversized input', async t => {
  const { gm } = fixture(t);
  for (const name of ['PSP/SAVEDATA/../../SYSTEM/file', '/PSP/SAVEDATA/GAME/file', 'PSP/SYSTEM/file', 'PSP/SAVEDATA/GAME/../file', 'PSP/SAVEDATA/GAME\\file']) {
    await assert.rejects(gm.importSaveData(await zip({ [name]: [1] })));
  }
  await assert.rejects(gm.importSaveData(await zip({ 'PSP/SAVEDATA/GAME/file': [1], 'PSP/SAVEDATA/GAME/file/child': [2] })), /invalid/);
  await assert.rejects(gm.importSaveData({ size: 64 * 1024 * 1024 + 1, arrayBuffer() { throw new Error('must not read'); } }), /invalid/);
});

test('empty PSP exports report no native data and preserve paused state', async t => {
  const { gm, emulator } = fixture(t);
  emulator.paused = true;
  await assert.rejects(gm.exportSaveData(), error => error.code === 'empty');
  assert.equal(emulator.paused, true);
});

test('concurrent native save operations are rejected while storage is pending', async t => {
  const { gm, put } = fixture(t);
  put(`${root}/GAME/DATA.BIN`, [1]);
  let finish;
  gm.FS.syncfs = (_, callback) => { finish = callback; };
  const exporting = gm.exportSaveData();
  await assert.rejects(gm.exportSaveData(), /busy/);
  await assert.rejects(gm.importSaveData(new Blob()), /busy/);
  finish(null);
  await exporting;
});

test('PSP imports accept compressed standard ZIP entries', async t => {
  const { gm, get } = fixture(t);
  const bytes = new Uint8Array(2048).fill(42);
  await gm.importSaveData(await zip({ 'PSP/SAVEDATA/GAME/DATA.BIN': bytes }, 6));
  assert.deepEqual(get(`${root}/GAME/DATA.BIN`), [...bytes]);
});

test('a ZIP checksum failure leaves the existing native save untouched', async t => {
  const { gm, put, get } = fixture(t);
  put(`${root}/GAME/DATA.BIN`, [99]);
  const archive = new Uint8Array(await (await zip({ 'PSP/SAVEDATA/GAME/DATA.BIN': [1, 2, 3] })).arrayBuffer());
  const view = new DataView(archive.buffer);
  const contentOffset = 30 + view.getUint16(26, true) + view.getUint16(28, true);
  archive[contentOffset] ^= 1;
  await assert.rejects(gm.importSaveData(new Blob([archive])));
  assert.deepEqual(get(`${root}/GAME/DATA.BIN`), [99]);
});
