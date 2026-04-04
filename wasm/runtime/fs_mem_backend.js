"use strict";

// In-memory filesystem backend kept separate from fs_backends.js so the OPFS
// implementation and shared shim logic stay easier to read.
(() => {
  if (globalThis.__lndWasmCreateMemFSBackend) {
    return;
  }

  globalThis.__lndWasmCreateMemFSBackend = function createMemFSBackend({
    S_IFDIR,
    S_IFREG,
    O_WRONLY,
    O_RDWR,
    O_CREAT,
    O_EXCL,
    O_TRUNC,
    O_APPEND,
    O_DIRECTORY,
    normalizePath,
    mkError,
  }) {
    function ensureSize(file, size) {
      if (file.data.length >= size) {
        return;
      }

      const next = new Uint8Array(size);
      next.set(file.data);
      file.data = next;
    }

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
  };
})();
