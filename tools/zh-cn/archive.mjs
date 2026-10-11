import fs from 'node:fs';
import { createHash } from 'node:crypto';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export function fileHash(file) {
  const fd = fs.openSync(file, 'r');
  const hash = createHash('sha256');
  const block = Buffer.alloc(4 * 1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(fd, block))) hash.update(block.subarray(0, count));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

function readExactly(fd, size, position) {
  const data = Buffer.alloc(size);
  let done = 0;
  while (done < size) {
    const n = fs.readSync(fd, data, done, size - done, position + done);
    if (!n) throw new Error('ASAR 文件不完整。');
    done += n;
  }
  return data;
}

export function openArchive(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const lead = readExactly(fd, 16, 0);
    const headerSize = lead.readUInt32LE(4);
    const jsonSize = lead.readUInt32LE(12);
    if (lead.readUInt32LE(0) !== 4 || headerSize < 8 || headerSize > 64 * 1024 * 1024 ||
        lead.readUInt32LE(8) !== headerSize - 4 || jsonSize > headerSize - 8 || 8 + headerSize > size) {
      throw new Error('不支持或已损坏的 ASAR 头部。');
    }
    const headerText = readExactly(fd, jsonSize, 16).toString('utf8');
    const header = JSON.parse(headerText);
    const base = 8 + headerSize;
    const entries = new Map();
    function walk(dir, prefix = '') {
      if (!dir.files || typeof dir.files !== 'object') throw new Error('ASAR 目录无效。');
      for (const [name, entry] of Object.entries(dir.files)) {
        if (!name || /[\\/]/.test(name) || name === '.' || name === '..') throw new Error('ASAR 路径无效。');
        const key = prefix + name;
        if (entry.files) walk(entry, key + '/');
        else {
          if (!entry.unpacked && !entry.link) {
            const offset = Number(entry.offset);
            if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(entry.size) ||
                entry.size < 0 || base + offset + entry.size > size) throw new Error('ASAR 文件偏移无效。');
          }
          entries.set(key, entry);
        }
      }
    }
    walk(header);
    return {
      fd, size, base, header, headerText, entries,
      read(name) {
        const e = entries.get(name);
        if (!e || e.unpacked || e.link) throw new Error(`缺少可修改的文件：${name}`);
        return readExactly(fd, e.size, base + Number(e.offset));
      },
      close() { fs.closeSync(fd); }
    };
  } catch (err) { fs.closeSync(fd); throw err; }
}

function integrity(data) {
  const blockSize = 4 * 1024 * 1024;
  const blocks = [];
  for (let p = 0; p < data.length; p += blockSize) blocks.push(sha256(data.subarray(p, p + blockSize)));
  if (!blocks.length) blocks.push(sha256(Buffer.alloc(0)));
  return { algorithm: 'SHA256', hash: sha256(data), blockSize, blocks };
}

export function applyEdits(source, plan) {
  if (sha256(source) !== plan.before) throw new Error(`文件校验失败：${plan.path}`);
  let text = source.toString('utf8');
  let boundary = text.length;
  for (const [start, end, old, replacement] of [...plan.edits].sort((a, b) => b[0] - a[0])) {
    if (!Number.isInteger(start) || start < 0 || end < start || end > boundary || text.slice(start, end) !== old) {
      throw new Error(`补丁位置校验失败：${plan.path}`);
    }
    text = text.slice(0, start) + replacement + text.slice(end);
    boundary = start;
  }
  const result = Buffer.from(text, 'utf8');
  if (sha256(result) !== plan.after) throw new Error(`补丁结果校验失败：${plan.path}`);
  return result;
}

// Keep all original payload bytes and offsets. Only edited entries point at appended data.
// This preserves unpacked files, symlinks, modes, and every untouched archive entry.
export function rebuildArchive(source, target, plans) {
  const archive = openArchive(source);
  let out;
  try {
    const header = structuredClone(archive.header);
    let offset = archive.size - archive.base;
    const changed = plans.map((plan) => {
      const data = applyEdits(archive.read(plan.path), plan);
      let entry = header;
      for (const segment of plan.path.split('/')) entry = entry.files[segment];
      entry.offset = String(offset);
      entry.size = data.length;
      entry.integrity = integrity(data);
      offset += data.length;
      return data;
    });
    const json = Buffer.from(JSON.stringify(header));
    const padded = Math.ceil((4 + json.length) / 4) * 4;
    const lead = Buffer.alloc(16 + Math.ceil(json.length / 4) * 4);
    lead.writeUInt32LE(4, 0);
    lead.writeUInt32LE(padded + 4, 4);
    lead.writeUInt32LE(padded, 8);
    lead.writeUInt32LE(json.length, 12);
    json.copy(lead, 16);
    out = fs.openSync(target, 'wx', fs.statSync(source).mode);
    const write = (data) => {
      let at = 0;
      while (at < data.length) at += fs.writeSync(out, data, at, data.length - at);
    };
    write(lead);
    const block = Buffer.alloc(4 * 1024 * 1024);
    for (let pos = archive.base; pos < archive.size;) {
      const count = fs.readSync(archive.fd, block, 0, Math.min(block.length, archive.size - pos), pos);
      if (!count) throw new Error('读取原始 ASAR 失败。');
      write(block.subarray(0, count));
      pos += count;
    }
    changed.forEach(write);
    fs.fsyncSync(out);
    fs.closeSync(out); out = undefined;
    const check = openArchive(target);
    try {
      for (const plan of plans) if (sha256(check.read(plan.path)) !== plan.after) throw new Error('写入后校验失败。');
    } finally { check.close(); }
    return sha256(json);
  } finally {
    if (out !== undefined) fs.closeSync(out);
    archive.close();
  }
}
