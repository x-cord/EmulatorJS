import { ZipWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, BlobReader } from '@zip.js/zip.js';

const CORE_SAVE_PROFILES = {
    ppsspp: { type: 'directory', path: '/data/saves/PSP/SAVEDATA', archivePrefix: 'PSP/SAVEDATA' }
};
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 2048;

export class NativeSaveFileError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const invalid = () => { throw new NativeSaveFileError('invalid'); };

const exists = (fs, path) => fs.analyzePath(path).exists;
const sync = gm => new Promise((resolve, reject) => gm.FS.syncfs(false, error => error ? reject(error) : resolve()));

function listFiles(fs, root, depth = 0, files = []) {
  if (!exists(fs, root)) return files;
  if (depth > 16) invalid();
  const stat = fs.lstat(root);
  if (fs.isDir(stat.mode)) {
    for (const name of fs.readdir(root).filter(name => name !== '.' && name !== '..')) {
      listFiles(fs, `${root}/${name}`, depth + 1, files);
    }
  } else {
    if (!fs.isFile(stat.mode) || files.length >= MAX_FILES) invalid();
    files.push({ path: root, size: stat.size });
  }
  return files;
}

function snapshot(fs, roots) {
  const files = [];
  for (const root of roots) listFiles(fs, root, 0, files);
  if (files.reduce((total, file) => total + file.size, 0) > MAX_BYTES) invalid();
  return new Map(files.map(file => [file.path, fs.readFile(file.path)]));
}

async function exportNativeFileSave(gm, profile) {
  await gm.flushSaveData();
  if (profile.type === 'file') {
    if (!exists(gm.FS, profile.path)) throw new NativeSaveFileError('empty');
    return { filename: profile.filename, save: gm.FS.readFile(profile.path), type: 'application/octet-stream' };
  }
  const files = snapshot(gm.FS, [profile.path]);
  if (!files.size) throw new NativeSaveFileError('empty');
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level: 0 });
  for (const [path, bytes] of files) {
    await writer.add(`${profile.archivePrefix}/${path.slice(profile.path.length + 1)}`, new Uint8ArrayReader(bytes));
  }
  return { filename: profile.filename, save: await writer.close(), type: 'application/zip' };
}

function archiveMember(name, directory, profile) {
  if (name.includes('\\') || /[\x00-\x1f:]/.test(name)) invalid();
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some(part => !part || part === '.' || part === '..') || parts.length > 16) invalid();
  const prefix = profile.archivePrefix.split('/');
  if (directory && parts.length <= prefix.length && parts.every((part, index) => part === prefix[index])) return null;
  if (!prefix.every((part, index) => parts[index] === part) || parts.length < prefix.length + (directory ? 1 : 2)) invalid();
  return parts.slice(prefix.length).join('/');
}

async function decodeNativeFileSave(file, profile, gm) {
  if (!file || file.size > MAX_BYTES) invalid();
  if (profile.type === 'file') {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!bytes.length) invalid();
    const memorySize = profile.source === 'retroarch' ? gm.Module._ejs_save_memory_size?.() : 0;
    if (memorySize && bytes.length !== memorySize) invalid();
    if (profile.source === 'core' && gm.Module._ejs_validate_native_save) {
      const pointer = gm.Module._malloc(bytes.length);
      if (!pointer) throw new NativeSaveFileError('memory');
      try {
        gm.Module.HEAPU8.set(bytes, pointer);
        if (!gm.Module._ejs_validate_native_save(pointer, bytes.length)) invalid();
      } finally { gm.Module._free(pointer); }
    }
    return new Map([['native', bytes]]);
  }
  const reader = new ZipReader(new BlobReader(file), { useWebWorkers: false });
  try {
    const entries = [];
    for await (const entry of reader.getEntriesGenerator()) {
      if (entries.length >= MAX_FILES) invalid();
      entries.push(entry);
    }
    const names = new Set();
    let declared = 0;
    for (const entry of entries) {
      const name = archiveMember(entry.filename, entry.directory, profile);
      if (name && names.has(name)) invalid();
      if (name) names.add(name);
      if (entry.encrypted || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) invalid();
      declared += entry.uncompressedSize || 0;
      if (declared > MAX_BYTES) invalid();
    }
    const files = new Map();
    let total = 0;
    for (const entry of entries) {
      if (entry.directory) continue;
      const chunks = [];
      let length = 0;
      await entry.getData(new WritableStream({
        write(chunk) {
          length += chunk.length;
          total += chunk.length;
          if (total > MAX_BYTES) invalid();
          chunks.push(chunk.slice());
        },
      }), { checkSignature: true, useWebWorkers: false });
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      files.set(archiveMember(entry.filename, false, profile), bytes);
    }
    if (!files.size) invalid();
    // A file cannot also serve as another entry's parent directory.
    for (const name of files.keys()) {
      const parts = name.split('/');
      while (parts.length > 1) {
        parts.pop();
        if (files.has(parts.join('/'))) invalid();
      }
    }
    return files;
  } finally {
    await reader.close();
  }
}

function removeTree(fs, path) {
  if (!exists(fs, path)) return;
  if (fs.isDir(fs.lstat(path).mode)) {
    for (const name of fs.readdir(path).filter(name => name !== '.' && name !== '..')) removeTree(fs, `${path}/${name}`);
    fs.rmdir(path);
  } else fs.unlink(path);
}
function writeFiles(fs, files) {
  for (const [path, bytes] of files) {
    fs.mkdirTree(path.slice(0, path.lastIndexOf('/')));
    fs.writeFile(path, bytes);
  }
}

export class NativeSave {
  constructor(gameManager) {
    this.gm = gameManager;
    this.busy = false;
    this.writing = false;
  }

  get descriptor() {
    const gm = this.gm;
    if (gm.EJS.started === false) return null;
    const pointer = gm.Module._ejs_native_save_path?.();
    if (pointer) {
      const path = gm.Module.UTF8ToString(pointer);
      return { type: 'file', source: 'core', path, filename: path.split('/').pop() };
    }
    const config = gm.EJS.nativeSaveConfig || CORE_SAVE_PROFILES[gm.EJS.getCore()];
    if (config) return { ...config, filename: `${gm.EJS.getBaseFileName()}-save-data.zip` };
    if (gm.EJS.saveFileExt === false && !(gm.Module._ejs_save_memory_size?.() > 0)) return null;
    const path = gm.functions.getSaveFilePath();
    return path ? { type: 'file', source: 'retroarch', path, filename: path.split('/').pop() } : null;
  }

  async flush() {
    if (this.gm.EJS.started === false) throw new NativeSaveFileError('not-started');
    if (this.writing) throw new NativeSaveFileError('busy');
    if (this.gm.saveSaveFiles() === false) throw new NativeSaveFileError('write');
    await sync(this.gm);
  }

  async paused(action) {
    const emulator = this.gm.EJS;
    const wasPaused = emulator.paused;
    if (!wasPaused) emulator.pause();
    try { return await action(); }
    finally { if (!wasPaused) emulator.play(); }
  }

  async export() {
    if (this.busy) throw new NativeSaveFileError('busy');
    this.busy = true;
    try {
      const profile = this.descriptor;
      if (!profile) throw new NativeSaveFileError('unsupported');
      return await this.paused(() => exportNativeFileSave(this.gm, profile));
    } finally { this.busy = false; }
  }

  async import(file) {
    if (this.busy) throw new NativeSaveFileError('busy');
    this.busy = true;
    let operation;
    let reloading = false;
    const emulator = this.gm.EJS;
    const wasPaused = emulator.paused;
    try {
      const profile = this.descriptor;
      if (!profile) throw new NativeSaveFileError('unsupported');
      if (!wasPaused) emulator.pause();
      this.gm.clearEJSResetTimer();
      operation = { success: false };
      await emulator.callEventAsync('beforeSaveDataImport', operation);
      const files = await decodeNativeFileSave(file, profile, this.gm);
      await this.flush();
      const mapped = profile.type === 'file'
        ? new Map([[profile.path, files.get('native')]])
        : new Map([...files].map(([name, bytes]) => [`${profile.path}/${name}`, bytes]));
      const roots = profile.type === 'file' ? [profile.path]
        : [...new Set([...files.keys()].map(name => `${profile.path}/${name.split('/')[0]}`))];
      const previous = snapshot(this.gm.FS, roots);
      this.writing = true;
      try {
        for (const root of roots) removeTree(this.gm.FS, root);
        writeFiles(this.gm.FS, mapped);
        await sync(this.gm);
        this.refresh(profile);
        await emulator.callEventAsync('saveDataImportCommit', operation);
        operation.success = true;
      } catch (error) {
        for (const root of roots) removeTree(this.gm.FS, root);
        writeFiles(this.gm.FS, previous);
        await sync(this.gm);
        this.refresh(profile);
        throw error;
      }
    } finally {
      if (operation) {
        try {
          const results = await emulator.callEventAsync('afterSaveDataImport', operation);
          reloading = results.some(result => result?.reloading);
        } catch (error) { console.warn('Save-data import completion hook failed', error); }
      }
      this.writing = false;
      this.busy = false;
      if (operation && !wasPaused && !reloading) emulator.play();
    }
  }

  refresh(profile) {
    if (!profile || profile.type !== 'file') return;
    if (profile.source === 'core') {
      if (!this.gm.Module._ejs_load_native_save?.()) throw new NativeSaveFileError('load');
    } else this.gm.functions.loadSaveFiles();
  }
}
