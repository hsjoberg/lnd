"use strict";

// Browser filesystem shim for the Go js/wasm runtime. It provides the
// Node-like globalThis.fs/process/path objects expected by wasm_exec.js and
// backs them with either in-memory storage or OPFS.
(() => {
  if (globalThis.__lndWasmPrepareFS) {
    return;
  }

  const S_IFDIR = 0o040000;
  const S_IFREG = 0o100000;
  const O_WRONLY = 0x1;
  const O_RDWR = 0x2;
  const O_CREAT = 0x40;
  const O_EXCL = 0x80;
  const O_TRUNC = 0x200;
  const O_APPEND = 0x400;
  const O_DIRECTORY = 0x10000;

  const runtime = { backend: null };
  const output = { buf: "" };
  const textDecoder = new TextDecoder();

  globalThis.__lndWasmStdoutLines = globalThis.__lndWasmStdoutLines || [];
  globalThis.__lndWasmOnStdoutLine = globalThis.__lndWasmOnStdoutLine || null;

  function mkError(code, message) {
    const err = new Error(message || code);
    err.code = code;
    return err;
  }

  function pushStdoutLine(line) {
    if (!line) {
      return;
    }

    globalThis.__lndWasmStdoutLines.push(line);
    if (globalThis.__lndWasmStdoutLines.length > 500) {
      globalThis.__lndWasmStdoutLines.shift();
    }

    if (typeof globalThis.__lndWasmOnStdoutLine === "function") {
      globalThis.__lndWasmOnStdoutLine(line);
    }
  }

  function writeStdout(buf) {
    output.buf += textDecoder.decode(buf);

    let nl = output.buf.indexOf("\n");
    while (nl !== -1) {
      const line = output.buf.slice(0, nl);
      console.log(line);
      pushStdoutLine(line);
      output.buf = output.buf.slice(nl + 1);
      nl = output.buf.indexOf("\n");
    }

    return buf.length;
  }

  function getBackend() {
    if (!runtime.backend) {
      throw mkError("ENOSYS", "filesystem backend is not initialized");
    }

    return runtime.backend;
  }

  function normalizePath(cwd, path) {
    const raw = String(path || "");
    const input = raw.startsWith("/") ? raw : `${cwd}/${raw}`;
    const parts = [];

    for (const part of input.split("/")) {
      if (!part || part === ".") {
        continue;
      }
      if (part === "..") {
        parts.pop();
        continue;
      }
      parts.push(part);
    }

    return `/${parts.join("/")}`;
  }

  function ensureSize(file, size) {
    if (file.data.length >= size) {
      return;
    }

    const next = new Uint8Array(size);
    next.set(file.data);
    file.data = next;
  }

  function createMemFSBackend() {
    const state = {
      mode: "memory",
      cwd: "/",
      nextFd: 100,
      nextIno: 2,
      root: null,
      fds: new Map(),
    };

    const makeDir = () => ({
      kind: "dir",
      mode: S_IFDIR | 0o755,
      ino: state.nextIno++,
      atimeMs: Date.now(),
      mtimeMs: Date.now(),
      ctimeMs: Date.now(),
      entries: new Map(),
    });

    const makeFile = () => ({
      kind: "file",
      mode: S_IFREG | 0o644,
      ino: state.nextIno++,
      atimeMs: Date.now(),
      mtimeMs: Date.now(),
      ctimeMs: Date.now(),
      data: new Uint8Array(0),
    });

    state.root = makeDir();
    state.fds.set(0, { node: makeFile(), path: "/dev/stdin", offset: 0 });
    state.fds.set(1, { node: makeFile(), path: "/dev/stdout", offset: 0 });
    state.fds.set(2, { node: makeFile(), path: "/dev/stderr", offset: 0 });

    const splitPath = (path) =>
      normalizePath(state.cwd, path).split("/").filter(Boolean);

    function lookup(path) {
      const normalized = normalizePath(state.cwd, path);
      if (normalized === "/") {
        return { node: state.root, path: "/" };
      }

      let current = state.root;
      for (const part of splitPath(normalized)) {
        if (current.kind !== "dir") {
          throw mkError("ENOTDIR");
        }
        const next = current.entries.get(part);
        if (!next) {
          throw mkError("ENOENT");
        }
        current = next;
      }

      return { node: current, path: normalized };
    }

    function lookupParent(path) {
      const normalized = normalizePath(state.cwd, path);
      if (normalized === "/") {
        throw mkError("EEXIST");
      }

      const parts = splitPath(normalized);
      const name = parts.pop();
      const parentPath = `/${parts.join("/")}`;
      const { node: parent } = lookup(parentPath || "/");
      if (parent.kind !== "dir") {
        throw mkError("ENOTDIR");
      }

      return { parent, name, path: normalized };
    }

    function statFromNode(node) {
      const size = node.kind === "file" ? node.data.length : node.entries.size;
      return {
        dev: 1,
        ino: node.ino,
        mode: node.mode,
        nlink: 1,
        uid: 0,
        gid: 0,
        rdev: 0,
        size,
        blksize: 4096,
        blocks: Math.ceil(size / 512),
        atimeMs: node.atimeMs,
        mtimeMs: node.mtimeMs,
        ctimeMs: node.ctimeMs,
        isDirectory: () => node.kind === "dir",
      };
    }

    return {
      mode: state.mode,
      normalizePath(path) {
        return normalizePath(state.cwd, path);
      },
      cwd() {
        return state.cwd;
      },
      chdir(path) {
        const { node, path: normalized } = lookup(path);
        if (node.kind !== "dir") {
          throw mkError("ENOTDIR");
        }
        state.cwd = normalized;
      },
      open(path, flags, mode) {
        const normalized = normalizePath(state.cwd, path);
        let lookedUp;
        let existed = true;

        try {
          lookedUp = lookup(normalized);
        } catch (err) {
          if (err.code !== "ENOENT") {
            throw err;
          }

          existed = false;
          if (!(flags & O_CREAT)) {
            throw err;
          }

          const { parent, name } = lookupParent(normalized);
          const file = makeFile();
          file.mode = S_IFREG | (mode || 0o644);
          parent.entries.set(name, file);
          parent.mtimeMs = Date.now();
          lookedUp = { node: file, path: normalized };
        }

        if (existed && flags & O_EXCL && flags & O_CREAT) {
          throw mkError("EEXIST");
        }

        if (flags & O_DIRECTORY && lookedUp.node.kind !== "dir") {
          throw mkError("ENOTDIR");
        }
        if (lookedUp.node.kind === "dir" && flags & (O_WRONLY | O_RDWR)) {
          throw mkError("EISDIR");
        }
        if (flags & O_TRUNC && lookedUp.node.kind === "file") {
          lookedUp.node.data = new Uint8Array(0);
          lookedUp.node.mtimeMs = Date.now();
        }

        const fd = state.nextFd++;
        state.fds.set(fd, {
          node: lookedUp.node,
          path: lookedUp.path,
          offset:
            flags & O_APPEND && lookedUp.node.kind === "file"
              ? lookedUp.node.data.length
              : 0,
        });

        return fd;
      },
      close(fd) {
        state.fds.delete(fd);
      },
      read(fd, buffer, offset, length, position) {
        const entry = state.fds.get(fd);
        if (!entry) {
          throw mkError("EBADF");
        }
        if (entry.node.kind !== "file") {
          throw mkError("EISDIR");
        }

        const start = position == null ? entry.offset : Number(position);
        const end = Math.min(start + length, entry.node.data.length);
        const slice = entry.node.data.subarray(start, end);
        buffer.set(slice, offset);
        entry.node.atimeMs = Date.now();
        if (position == null) {
          entry.offset = end;
        }

        return slice.length;
      },
      write(fd, buf, offset, length, position) {
        const entry = state.fds.get(fd);
        if (!entry) {
          throw mkError("EBADF");
        }
        if (entry.node.kind !== "file") {
          throw mkError("EISDIR");
        }

        const start = position == null ? entry.offset : Number(position);
        const end = start + length;
        ensureSize(entry.node, end);
        entry.node.data.set(buf.subarray(offset, offset + length), start);
        entry.node.mtimeMs = Date.now();
        entry.node.atimeMs = Date.now();
        if (position == null) {
          entry.offset = end;
        }

        return length;
      },
      stat(path) {
        return statFromNode(lookup(path).node);
      },
      lstat(path) {
        return statFromNode(lookup(path).node);
      },
      fstat(fd) {
        const entry = state.fds.get(fd);
        if (!entry) {
          throw mkError("EBADF");
        }

        return statFromNode(entry.node);
      },
      mkdir(path, perm) {
        const normalized = normalizePath(state.cwd, path);
        try {
          const { node } = lookup(normalized);
          if (node.kind !== "dir") {
            throw mkError("ENOTDIR");
          }
          throw mkError("EEXIST");
        } catch (err) {
          if (err.code !== "ENOENT") {
            throw err;
          }
        }

        const { parent, name } = lookupParent(normalized);
        const dir = makeDir();
        dir.mode = S_IFDIR | (perm || 0o755);
        parent.entries.set(name, dir);
        parent.mtimeMs = Date.now();
      },
      readdir(path) {
        const { node } = lookup(path);
        if (node.kind !== "dir") {
          throw mkError("ENOTDIR");
        }

        return Array.from(node.entries.keys()).sort();
      },
      unlink(path) {
        const { parent, name } = lookupParent(path);
        const node = parent.entries.get(name);
        if (!node) {
          throw mkError("ENOENT");
        }
        if (node.kind === "dir") {
          throw mkError("EISDIR");
        }

        parent.entries.delete(name);
        parent.mtimeMs = Date.now();
      },
      rmdir(path) {
        const { parent, name } = lookupParent(path);
        const node = parent.entries.get(name);
        if (!node) {
          throw mkError("ENOENT");
        }
        if (node.kind !== "dir") {
          throw mkError("ENOTDIR");
        }
        if (node.entries.size !== 0) {
          throw mkError("ENOTEMPTY");
        }

        parent.entries.delete(name);
        parent.mtimeMs = Date.now();
      },
      rename(from, to) {
        const { parent: fromParent, name: fromName } = lookupParent(from);
        const node = fromParent.entries.get(fromName);
        if (!node) {
          throw mkError("ENOENT");
        }

        const { parent: toParent, name: toName } = lookupParent(to);
        fromParent.entries.delete(fromName);
        toParent.entries.set(toName, node);
        const now = Date.now();
        fromParent.mtimeMs = now;
        toParent.mtimeMs = now;
      },
      truncate(path, length) {
        const { node } = lookup(path);
        if (node.kind !== "file") {
          throw mkError("EISDIR");
        }

        const size = Number(length);
        if (size < node.data.length) {
          node.data = node.data.subarray(0, size);
        } else {
          ensureSize(node, size);
        }
        node.mtimeMs = Date.now();
      },
      ftruncate(fd, length) {
        const entry = state.fds.get(fd);
        if (!entry) {
          throw mkError("EBADF");
        }

        this.truncate(entry.path, length);
      },
      fsync() {},
      chmod(path, mode) {
        const { node } = lookup(path);
        node.mode = (node.mode & 0o170000) | Number(mode);
      },
      fchmod(fd, mode) {
        const entry = state.fds.get(fd);
        if (!entry) {
          throw mkError("EBADF");
        }
        entry.node.mode = (entry.node.mode & 0o170000) | Number(mode);
      },
      chown() {},
      fchown() {},
      lchown() {},
      link() {
        throw mkError("ENOSYS");
      },
      readlink() {
        throw mkError("EINVAL");
      },
      symlink() {
        throw mkError("ENOSYS");
      },
      utimes(path, atime, mtime) {
        const { node } = lookup(path);
        node.atimeMs = Number(atime) * 1000;
        node.mtimeMs = Number(mtime) * 1000;
      },
    };
  }

  async function createOPFSBackend() {
    if (
      !navigator.storage ||
      typeof navigator.storage.getDirectory !== "function"
    ) {
      throw new Error("OPFS is not available in this browser/context");
    }

    const rootHandle = await navigator.storage.getDirectory();
    const state = {
      mode: "opfs",
      cwd: "/",
      nextFd: 100,
      nextIno: 2,
      fds: new Map(),
      inoByPath: new Map([["/", 1]]),
    };

    function assignIno(path) {
      const normalized = normalizePath(state.cwd, path);
      if (!state.inoByPath.has(normalized)) {
        state.inoByPath.set(normalized, state.nextIno++);
      }
      return state.inoByPath.get(normalized);
    }

    function clearInoPath(path) {
      const normalized = normalizePath(state.cwd, path);
      for (const key of Array.from(state.inoByPath.keys())) {
        if (key === normalized || key.startsWith(`${normalized}/`)) {
          state.inoByPath.delete(key);
        }
      }
    }

    function splitPath(path) {
      return normalizePath(state.cwd, path).split("/").filter(Boolean);
    }

    function mapOPFSError(err, fallback) {
      if (!err || typeof err !== "object") {
        return mkError(fallback || "EIO");
      }

      switch (err.name) {
        case "NotFoundError":
          return mkError("ENOENT");
        case "TypeMismatchError":
          return mkError("ENOTDIR");
        case "NoModificationAllowedError":
          return mkError("EPERM");
        case "InvalidModificationError":
          return mkError("ENOTEMPTY");
        case "NotAllowedError":
          return mkError("EPERM");
        default:
          return mkError(fallback || "EIO", String(err.message || err));
      }
    }

    async function getParentDirectory(path, create) {
      const normalized = normalizePath(state.cwd, path);
      if (normalized === "/") {
        throw mkError("EEXIST");
      }

      const parts = splitPath(normalized);
      parts.pop();

      let current = rootHandle;
      let currentPath = "";
      for (const part of parts) {
        currentPath += `/${part}`;
        try {
          current = await current.getDirectoryHandle(part, { create });
          assignIno(currentPath);
        } catch (err) {
          throw mapOPFSError(err, create ? "EIO" : "ENOENT");
        }
      }

      return current;
    }

    async function getDirectoryHandle(path, create) {
      const normalized = normalizePath(state.cwd, path);
      if (normalized === "/") {
        return rootHandle;
      }

      let current = rootHandle;
      let currentPath = "";
      for (const part of splitPath(normalized)) {
        currentPath += `/${part}`;
        try {
          current = await current.getDirectoryHandle(part, { create });
          assignIno(currentPath);
        } catch (err) {
          throw mapOPFSError(err, create ? "EIO" : "ENOENT");
        }
      }

      return current;
    }

    async function getEntry(path) {
      const normalized = normalizePath(state.cwd, path);
      if (normalized === "/") {
        return { kind: "dir", handle: rootHandle, path: "/" };
      }

      const parts = splitPath(normalized);
      const name = parts[parts.length - 1];
      const parent = await getParentDirectory(normalized, false);

      try {
        const fileHandle = await parent.getFileHandle(name);
        assignIno(normalized);
        return { kind: "file", handle: fileHandle, path: normalized };
      } catch (fileErr) {
        if (
          fileErr &&
          fileErr.name &&
          fileErr.name !== "NotFoundError" &&
          fileErr.name !== "TypeMismatchError"
        ) {
          throw mapOPFSError(fileErr);
        }
      }

      try {
        const dirHandle = await parent.getDirectoryHandle(name);
        assignIno(normalized);
        return { kind: "dir", handle: dirHandle, path: normalized };
      } catch (dirErr) {
        if (
          dirErr &&
          dirErr.name &&
          dirErr.name !== "NotFoundError" &&
          dirErr.name !== "TypeMismatchError"
        ) {
          throw mapOPFSError(dirErr, "ENOENT");
        }

        throw mkError("ENOENT");
      }
    }

    async function tryGetEntry(path) {
      try {
        return await getEntry(path);
      } catch (err) {
        if (err.code === "ENOENT") {
          return null;
        }
        throw err;
      }
    }

    async function readFileData(handle) {
      const file = await handle.getFile();
      return {
        data: new Uint8Array(await file.arrayBuffer()),
        mtimeMs: file.lastModified || Date.now(),
      };
    }

    async function countDirectoryEntries(handle) {
      let count = 0;
      for await (const _entry of handle.values()) {
        count++;
      }
      return count;
    }

    async function removeExistingDestination(path) {
      const existing = await tryGetEntry(path);
      if (!existing) {
        return;
      }

      if (existing.kind === "dir") {
        const count = await countDirectoryEntries(existing.handle);
        if (count !== 0) {
          throw mkError("ENOTEMPTY");
        }
      }

      const parent = await getParentDirectory(path, false);
      const parts = splitPath(path);
      await parent.removeEntry(parts[parts.length - 1], { recursive: false });
      clearInoPath(path);
    }

    async function copyEntry(sourcePath, destPath) {
      const source = await getEntry(sourcePath);
      if (source.kind === "file") {
        const parent = await getParentDirectory(destPath, false);
        const parts = splitPath(destPath);
        const name = parts[parts.length - 1];
        const fileHandle = await parent.getFileHandle(name, { create: true });
        const writable = await fileHandle.createWritable();
        const file = await source.handle.getFile();
        await writable.write(await file.arrayBuffer());
        await writable.close();
        assignIno(destPath);
        return;
      }

      const parent = await getParentDirectory(destPath, false);
      const parts = splitPath(destPath);
      const name = parts[parts.length - 1];
      await parent.getDirectoryHandle(name, { create: true });
      assignIno(destPath);

      for await (const [childName] of source.handle.entries()) {
        const childSource = `${normalizePath(state.cwd, sourcePath)}/${childName}`;
        const childDest = `${normalizePath(state.cwd, destPath)}/${childName}`;
        await copyEntry(childSource, childDest);
      }
    }

    async function flushFD(entry) {
      if (!entry || entry.kind !== "file" || !entry.dirty) {
        return;
      }

      const writable = await entry.handle.createWritable();
      await writable.write(entry.data);
      await writable.close();
      entry.dirty = false;
    }

    function makeStatForDir(path, size) {
      return {
        dev: 1,
        ino: assignIno(path),
        mode: S_IFDIR | 0o755,
        nlink: 1,
        uid: 0,
        gid: 0,
        rdev: 0,
        size,
        blksize: 4096,
        blocks: Math.ceil(size / 512),
        atimeMs: Date.now(),
        mtimeMs: Date.now(),
        ctimeMs: Date.now(),
        isDirectory: () => true,
      };
    }

    function makeStatForFile(path, size, mtimeMs) {
      return {
        dev: 1,
        ino: assignIno(path),
        mode: S_IFREG | 0o644,
        nlink: 1,
        uid: 0,
        gid: 0,
        rdev: 0,
        size,
        blksize: 4096,
        blocks: Math.ceil(size / 512),
        atimeMs: mtimeMs,
        mtimeMs,
        ctimeMs: mtimeMs,
        isDirectory: () => false,
      };
    }

    return {
      mode: state.mode,
      normalizePath(path) {
        return normalizePath(state.cwd, path);
      },
      cwd() {
        return state.cwd;
      },
      chdir(path) {
        state.cwd = normalizePath(state.cwd, path);
      },
      async open(path, flags, mode) {
        const normalized = normalizePath(state.cwd, path);

        if (flags & O_DIRECTORY) {
          const dirHandle = await getDirectoryHandle(normalized, false);
          const fd = state.nextFd++;
          state.fds.set(fd, {
            kind: "dir",
            handle: dirHandle,
            path: normalized,
            position: 0,
          });
          return fd;
        }

        let entry = await tryGetEntry(normalized);
        if (entry && flags & O_EXCL && flags & O_CREAT) {
          throw mkError("EEXIST");
        }
        if (!entry) {
          if (!(flags & O_CREAT)) {
            throw mkError("ENOENT");
          }

          const parent = await getParentDirectory(normalized, false);
          const parts = splitPath(normalized);
          const name = parts[parts.length - 1];
          const handle = await parent.getFileHandle(name, { create: true });
          assignIno(normalized);
          entry = { kind: "file", handle, path: normalized };
        }

        if (entry.kind !== "file") {
          throw mkError("EISDIR");
        }

        let data = new Uint8Array(0);
        let mtimeMs = Date.now();
        if (!(flags & O_TRUNC)) {
          const existing = await readFileData(entry.handle);
          data = existing.data;
          mtimeMs = existing.mtimeMs;
        }

        const fd = state.nextFd++;
        state.fds.set(fd, {
          kind: "file",
          handle: entry.handle,
          path: normalized,
          data,
          mtimeMs,
          dirty: Boolean(flags & O_TRUNC),
          position: flags & O_APPEND ? data.length : 0,
          // Some append-only users, notably neutrino headerfs, keep files open
          // for the lifetime of the process and rely on append writes being
          // durably reflected on disk without an explicit close on shutdown.
          writeThrough: Boolean(flags & O_APPEND),
          mode: S_IFREG | (mode || 0o644),
        });
        return fd;
      },
      async close(fd) {
        const entry = state.fds.get(fd);
        if (!entry) {
          return;
        }

        await flushFD(entry);
        state.fds.delete(fd);
      },
      read(fd, buffer, offset, length, position) {
        const entry = state.fds.get(fd);
        if (!entry) {
          throw mkError("EBADF");
        }
        if (entry.kind !== "file") {
          throw mkError("EISDIR");
        }

        const start = position == null ? entry.position : Number(position);
        const end = Math.min(start + length, entry.data.length);
        const slice = entry.data.subarray(start, end);
        buffer.set(slice, offset);
        if (position == null) {
          entry.position = end;
        }
        return slice.length;
      },
      async write(fd, buf, offset, length, position) {
        const entry = state.fds.get(fd);
        if (!entry) {
          throw mkError("EBADF");
        }
        if (entry.kind !== "file") {
          throw mkError("EISDIR");
        }

        const start = position == null ? entry.position : Number(position);
        const end = start + length;
        ensureSize(entry, end);
        entry.data.set(buf.subarray(offset, offset + length), start);
        entry.mtimeMs = Date.now();
        entry.dirty = true;
        if (position == null) {
          entry.position = end;
        }

        if (entry.writeThrough) {
          await flushFD(entry);
        }

        return length;
      },
      async stat(path) {
        const entry = await getEntry(path);
        if (entry.kind === "dir") {
          return makeStatForDir(
            entry.path,
            await countDirectoryEntries(entry.handle),
          );
        }

        const file = await entry.handle.getFile();
        return makeStatForFile(
          entry.path,
          file.size,
          file.lastModified || Date.now(),
        );
      },
      async lstat(path) {
        return this.stat(path);
      },
      async fstat(fd) {
        const entry = state.fds.get(fd);
        if (!entry) {
          throw mkError("EBADF");
        }
        if (entry.kind === "dir") {
          return makeStatForDir(
            entry.path,
            await countDirectoryEntries(entry.handle),
          );
        }

        return makeStatForFile(
          entry.path,
          entry.data.length,
          entry.mtimeMs || Date.now(),
        );
      },
      async mkdir(path) {
        const normalized = normalizePath(state.cwd, path);
        if (await tryGetEntry(normalized)) {
          throw mkError("EEXIST");
        }

        const parent = await getParentDirectory(normalized, false);
        const parts = splitPath(normalized);
        await parent.getDirectoryHandle(parts[parts.length - 1], {
          create: true,
        });
        assignIno(normalized);
      },
      async readdir(path) {
        const entry = await getEntry(path);
        if (entry.kind !== "dir") {
          throw mkError("ENOTDIR");
        }

        const names = [];
        for await (const [name] of entry.handle.entries()) {
          names.push(name);
        }
        names.sort();
        return names;
      },
      async unlink(path) {
        const normalized = normalizePath(state.cwd, path);
        const entry = await getEntry(normalized);
        if (entry.kind !== "file") {
          throw mkError("EISDIR");
        }

        const parent = await getParentDirectory(normalized, false);
        const parts = splitPath(normalized);
        await parent.removeEntry(parts[parts.length - 1], { recursive: false });
        clearInoPath(normalized);
      },
      async rmdir(path) {
        const normalized = normalizePath(state.cwd, path);
        const entry = await getEntry(normalized);
        if (entry.kind !== "dir") {
          throw mkError("ENOTDIR");
        }
        if (await countDirectoryEntries(entry.handle)) {
          throw mkError("ENOTEMPTY");
        }

        const parent = await getParentDirectory(normalized, false);
        const parts = splitPath(normalized);
        await parent.removeEntry(parts[parts.length - 1], { recursive: false });
        clearInoPath(normalized);
      },
      async rename(from, to) {
        const sourcePath = normalizePath(state.cwd, from);
        const destPath = normalizePath(state.cwd, to);
        if (sourcePath === destPath) {
          return;
        }

        await removeExistingDestination(destPath);
        await copyEntry(sourcePath, destPath);

        const source = await getEntry(sourcePath);
        const parent = await getParentDirectory(sourcePath, false);
        const parts = splitPath(sourcePath);
        await parent.removeEntry(parts[parts.length - 1], {
          recursive: source.kind === "dir",
        });
        clearInoPath(sourcePath);
      },
      async truncate(path, length) {
        const normalized = normalizePath(state.cwd, path);
        const entry = await getEntry(normalized);
        if (entry.kind !== "file") {
          throw mkError("EISDIR");
        }

        const current = await readFileData(entry.handle);
        let next = current.data;
        const size = Number(length);
        if (size < next.length) {
          next = next.subarray(0, size);
        } else {
          const grown = new Uint8Array(size);
          grown.set(next);
          next = grown;
        }

        const writable = await entry.handle.createWritable();
        await writable.write(next);
        await writable.close();
      },
      async ftruncate(fd, length) {
        const entry = state.fds.get(fd);
        if (!entry) {
          throw mkError("EBADF");
        }
        if (entry.kind !== "file") {
          throw mkError("EISDIR");
        }

        const size = Number(length);
        if (size < entry.data.length) {
          entry.data = entry.data.subarray(0, size);
        } else {
          ensureSize(entry, size);
        }
        entry.mtimeMs = Date.now();
        entry.dirty = true;
      },
      async fsync(fd) {
        const entry = state.fds.get(fd);
        if (!entry) {
          throw mkError("EBADF");
        }

        await flushFD(entry);
      },
      chmod() {},
      fchmod() {},
      chown() {},
      fchown() {},
      lchown() {},
      link() {
        throw mkError("ENOSYS");
      },
      readlink() {
        throw mkError("EINVAL");
      },
      symlink() {
        throw mkError("ENOSYS");
      },
      utimes() {},
    };
  }

  function callbackify(method, callback, ...args) {
    Promise.resolve()
      .then(() => method(...args))
      .then((result) => callback(null, result))
      .catch((err) => callback(err));
  }

  globalThis.path = {
    resolve: (...parts) => getBackend().normalizePath(parts.join("/")),
  };

  globalThis.process = {
    getuid: () => 0,
    getgid: () => 0,
    geteuid: () => 0,
    getegid: () => 0,
    getgroups: () => [],
    pid: 1,
    ppid: 1,
    umask: () => 0,
    cwd: () => getBackend().cwd(),
    chdir: (path) => getBackend().chdir(path),
  };

  globalThis.fs = {
    constants: {
      O_WRONLY,
      O_RDWR,
      O_CREAT,
      O_TRUNC,
      O_APPEND,
      O_EXCL,
      O_DIRECTORY,
    },
    writeSync(fd, buf) {
      if (fd === 1 || fd === 2) {
        return writeStdout(buf);
      }

      throw mkError("ENOSYS");
    },
    write(fd, buf, offset, length, position, callback) {
      if (fd === 1 || fd === 2) {
        callback(null, writeStdout(buf.subarray(offset, offset + length)));
        return;
      }

      callbackify(
        (...args) => getBackend().write(...args),
        callback,
        fd,
        buf,
        offset,
        length,
        position,
      );
    },
    read(fd, buffer, offset, length, position, callback) {
      callbackify(
        (...args) => getBackend().read(...args),
        callback,
        fd,
        buffer,
        offset,
        length,
        position,
      );
    },
    open(path, flags, mode, callback) {
      callbackify(
        (...args) => getBackend().open(...args),
        callback,
        path,
        flags,
        mode,
      );
    },
    close(fd, callback) {
      callbackify((fileFD) => getBackend().close(fileFD), callback, fd);
    },
    stat(path, callback) {
      callbackify((filePath) => getBackend().stat(filePath), callback, path);
    },
    lstat(path, callback) {
      callbackify((filePath) => getBackend().lstat(filePath), callback, path);
    },
    fstat(fd, callback) {
      callbackify((fileFD) => getBackend().fstat(fileFD), callback, fd);
    },
    mkdir(path, perm, callback) {
      callbackify(
        (dirPath, dirPerm) => getBackend().mkdir(dirPath, dirPerm),
        callback,
        path,
        perm,
      );
    },
    readdir(path, callback) {
      callbackify((dirPath) => getBackend().readdir(dirPath), callback, path);
    },
    unlink(path, callback) {
      callbackify((filePath) => getBackend().unlink(filePath), callback, path);
    },
    rmdir(path, callback) {
      callbackify((dirPath) => getBackend().rmdir(dirPath), callback, path);
    },
    rename(from, to, callback) {
      callbackify(
        (src, dst) => getBackend().rename(src, dst),
        callback,
        from,
        to,
      );
    },
    truncate(path, length, callback) {
      callbackify(
        (filePath, size) => getBackend().truncate(filePath, size),
        callback,
        path,
        length,
      );
    },
    ftruncate(fd, length, callback) {
      callbackify(
        (fileFD, size) => getBackend().ftruncate(fileFD, size),
        callback,
        fd,
        length,
      );
    },
    fsync(fd, callback) {
      callbackify((fileFD) => getBackend().fsync(fileFD), callback, fd);
    },
    chmod(path, mode, callback) {
      callbackify(
        (filePath, nextMode) => getBackend().chmod(filePath, nextMode),
        callback,
        path,
        mode,
      );
    },
    fchmod(fd, mode, callback) {
      callbackify(
        (fileFD, nextMode) => getBackend().fchmod(fileFD, nextMode),
        callback,
        fd,
        mode,
      );
    },
    chown(path, uid, gid, callback) {
      callbackify(
        (filePath, nextUID, nextGID) =>
          getBackend().chown(filePath, nextUID, nextGID),
        callback,
        path,
        uid,
        gid,
      );
    },
    fchown(fd, uid, gid, callback) {
      callbackify(
        (fileFD, nextUID, nextGID) =>
          getBackend().fchown(fileFD, nextUID, nextGID),
        callback,
        fd,
        uid,
        gid,
      );
    },
    lchown(path, uid, gid, callback) {
      callbackify(
        (filePath, nextUID, nextGID) =>
          getBackend().lchown(filePath, nextUID, nextGID),
        callback,
        path,
        uid,
        gid,
      );
    },
    link(path, link, callback) {
      callbackify(
        (src, dst) => getBackend().link(src, dst),
        callback,
        path,
        link,
      );
    },
    readlink(path, callback) {
      callbackify(
        (filePath) => getBackend().readlink(filePath),
        callback,
        path,
      );
    },
    symlink(path, link, callback) {
      callbackify(
        (src, dst) => getBackend().symlink(src, dst),
        callback,
        path,
        link,
      );
    },
    utimes(path, atime, mtime, callback) {
      callbackify(
        (filePath, nextATime, nextMTime) =>
          getBackend().utimes(filePath, nextATime, nextMTime),
        callback,
        path,
        atime,
        mtime,
      );
    },
  };

  globalThis.__lndWasmPrepareFS = async (mode) => {
    const nextMode = mode || "opfs";

    switch (nextMode) {
      case "memory":
        runtime.backend = createMemFSBackend();
        break;
      case "opfs":
        runtime.backend = await createOPFSBackend();
        break;
      default:
        throw new Error(`unknown fs backend: ${nextMode}`);
    }

    return { mode: runtime.backend.mode };
  };
})();
