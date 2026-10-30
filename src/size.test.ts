import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DirectoryEntry,
  FileType,
  getEntrySize,
  SizeCancelledError,
  SizeEntry,
  SizeFs,
  SizeResult,
} from './size.js';

interface Node {
  type: number;
  size?: number;
  children?: Record<string, Node>;
}

/** Build a SizeFs backed by an in-memory tree. */
function mockFs(root: Node): SizeFs<string> {
  function resolve(path: string): Node | null {
    if (path === '/' || path === '') {
      return root;
    }
    const parts = path.split('/').filter(Boolean);
    let node: Node = root;
    for (const part of parts) {
      if (!node.children) {
        return null;
      }
      const next = node.children[part];
      if (!next) {
        return null;
      }
      node = next;
    }
    return node;
  }

  return {
    async stat(path) {
      const node = resolve(path);
      if (!node) {
        throw new Error('ENOENT');
      }
      const stat: SizeEntry = { type: node.type, size: node.size ?? 0 };
      return stat;
    },
    async readDirectory(path) {
      const node = resolve(path);
      if (!node || !node.children) {
        throw new Error('ENOTDIR');
      }
      const entries: DirectoryEntry<string>[] = Object.entries(node.children).map(
        ([name, child]) => ({
          path: path === '/' ? `/${name}` : `${path}/${name}`,
          type: child.type,
        }),
      );
      return entries;
    },
  };
}

describe('getEntrySize', () => {
  it('returns the size of a single file', async () => {
    const root: Node = {
      type: FileType.Directory,
      children: { 'a.txt': { type: FileType.File, size: 42 } },
    };
    const result = await getEntrySize(mockFs(root), '/a.txt');
    assert.deepEqual(result, { bytes: 42, fileCount: 1, dirCount: 0, skippedCount: 0 });
  });

  it('recursively sums a directory tree', async () => {
    const root: Node = {
      type: FileType.Directory,
      children: {
        'a.txt': { type: FileType.File, size: 10 },
        sub: {
          type: FileType.Directory,
          children: {
            'b.txt': { type: FileType.File, size: 20 },
            deep: {
              type: FileType.Directory,
              children: { 'c.txt': { type: FileType.File, size: 30 } },
            },
          },
        },
      },
    };
    const result = await getEntrySize(mockFs(root), '/');
    assert.deepEqual(result, { bytes: 60, fileCount: 3, dirCount: 2, skippedCount: 0 });
  });

  it('skips symbolic links entirely', async () => {
    const root: Node = {
      type: FileType.Directory,
      children: {
        'a.txt': { type: FileType.File, size: 10 },
        loop: { type: FileType.SymbolicLink, size: 0 },
        fileLink: { type: FileType.SymbolicLink | FileType.File, size: 500 },
        directoryLink: { type: FileType.SymbolicLink | FileType.Directory },
      },
    };
    const result = await getEntrySize(mockFs(root), '/');
    assert.deepEqual(result, { bytes: 10, fileCount: 1, dirCount: 0, skippedCount: 0 });

    const linkOnly = await getEntrySize(mockFs(root), '/loop');
    assert.deepEqual(linkOnly, { bytes: 0, fileCount: 0, dirCount: 0, skippedCount: 0 });
    const directoryLink = await getEntrySize(mockFs(root), '/directoryLink');
    assert.deepEqual(directoryLink, linkOnly);
  });

  it('propagates the original root stat failure', async () => {
    const error = new Error('ENOENT');
    const fs: SizeFs = {
      async stat() { throw error; },
      async readDirectory() { assert.fail('must not read an inaccessible root'); },
    };
    await assert.rejects(() => getEntrySize(fs, '/missing'), (err) => err === error);
  });

  it('throws SizeCancelledError when cancelled at the root', async () => {
    const token = { isCancellationRequested: true };
    const fs: SizeFs = {
      async stat() { assert.fail('cancelled scan must not stat'); },
      async readDirectory() { assert.fail('cancelled scan must not read'); },
    };
    await assert.rejects(
      () => getEntrySize(fs, '/', token),
      SizeCancelledError,
    );
  });

  it('throws SizeCancelledError when cancelled mid-walk', async () => {
    const root: Node = {
      type: FileType.Directory,
      children: {
        'a.txt': { type: FileType.File, size: 1 },
        sub: {
          type: FileType.Directory,
          children: { 'b.txt': { type: FileType.File, size: 2 } },
        },
      },
    };
    const token = { isCancellationRequested: false };
    const fs = mockFs(root);
    // Flip cancellation when the nested directory is being read, i.e. after
    // the root's `a.txt` has already been processed.
    let calls = 0;
    const wrapped: SizeFs<string> = {
      stat: fs.stat,
      async readDirectory(path) {
        calls += 1;
        if (calls > 1) {
          token.isCancellationRequested = true;
        }
        return fs.readDirectory(path);
      },
    };

    await assert.rejects(() => getEntrySize(wrapped, '/', token), SizeCancelledError);
  });
});

describe('partial size results', () => {
  it('propagates the original root directory read failure', async () => {
    const error = new Error('EACCES');
    const fs: SizeFs = {
      async stat() { return { type: FileType.Directory, size: 0 }; },
      async readDirectory() { throw error; },
    };
    await assert.rejects(() => getEntrySize(fs, '/'), (err) => err === error);
  });

  it('counts unreadable entries once and continues scanning readable siblings', async () => {
    const tree = mockFs({
      type: FileType.Directory,
      children: {
        missing: { type: FileType.File, size: 100 },
        'a.txt': { type: FileType.File, size: 10 },
        readable: {
          type: FileType.Directory,
          children: {
            'b.txt': { type: FileType.File, size: 20 },
            empty: { type: FileType.Directory, children: {} },
          },
        },
        denied: {
          type: FileType.Directory,
          children: { unseen: { type: FileType.File, size: 200 } },
        },
      },
    });
    const reads: string[] = [];
    const fs: SizeFs = {
      async stat(path) {
        if (path === '/missing') {
          throw new Error('ENOENT');
        }
        return tree.stat(path);
      },
      async readDirectory(path) {
        reads.push(path);
        if (path === '/denied') {
          throw new Error('EACCES');
        }
        return tree.readDirectory(path);
      },
    };

    assert.deepEqual(await getEntrySize(fs, '/'), {
      bytes: 30, fileCount: 2, dirCount: 2, skippedCount: 2,
    });
    assert.deepEqual(reads, ['/', '/denied', '/readable', '/readable/empty']);
  });

  it('does not count an entry that becomes a symbolic link before stat', async () => {
    const fs: SizeFs = {
      async stat(path) {
        return path === '/'
          ? { type: FileType.Directory, size: 0 }
          : { type: FileType.File | FileType.SymbolicLink, size: 100 };
      },
      async readDirectory() { return [{ path: '/changed', type: FileType.File }]; },
    };
    assert.deepEqual(await getEntrySize(fs, '/'), {
      bytes: 0, fileCount: 0, dirCount: 0, skippedCount: 0,
    });
  });

  it('does not swallow a provider cancellation as an unreadable descendant', async () => {
    const fs: SizeFs = {
      async stat(path) {
        if (path === '/') {
          return { type: FileType.Directory, size: 0 };
        }
        throw new SizeCancelledError();
      },
      async readDirectory() { return [{ path: '/child', type: FileType.File }]; },
    };
    await assert.rejects(() => getEntrySize(fs, '/'), SizeCancelledError);
  });
});

describe('cancellation at asynchronous boundaries', () => {
  for (const type of [FileType.File, FileType.Directory, FileType.SymbolicLink]) {
    it(`cancels after root stat for entry type ${type}`, async () => {
      const token = { isCancellationRequested: false };
      const fs: SizeFs = {
        async stat() {
          token.isCancellationRequested = true;
          return { type, size: 42 };
        },
        async readDirectory() { assert.fail('must not read after cancellation'); },
      };
      await assert.rejects(
        () => getEntrySize(fs, '/', token, {
          onProgress() { assert.fail('must not report after cancellation'); },
        }),
        SizeCancelledError,
      );
    });
  }

  for (const rejects of [false, true]) {
    const outcome = rejects ? 'rejects' : 'resolves';

    it(`cancels when an empty root directory read ${outcome}`, async () => {
      const token = { isCancellationRequested: false };
      const fs: SizeFs = {
        async stat() { return { type: FileType.Directory, size: 0 }; },
        async readDirectory() {
          token.isCancellationRequested = true;
          if (rejects) {
            throw new Error('EACCES');
          }
          return [];
        },
      };
      await assert.rejects(
        () => getEntrySize(fs, '/', token, {
          onProgress() { assert.fail('must not report after cancellation'); },
        }),
        SizeCancelledError,
      );
    });

    it(`cancels when the final child stat ${outcome}`, async () => {
      const token = { isCancellationRequested: false };
      const fs: SizeFs = {
        async stat(path) {
          if (path === '/') {
            return { type: FileType.Directory, size: 0 };
          }
          token.isCancellationRequested = true;
          if (rejects) {
            throw new Error('ENOENT');
          }
          return { type: FileType.File, size: 42 };
        },
        async readDirectory() { return [{ path: '/last', type: FileType.File }]; },
      };
      await assert.rejects(
        () => getEntrySize(fs, '/', token, {
          onProgress() { assert.fail('must not report after cancellation'); },
        }),
        SizeCancelledError,
      );
    });

    it(`stops pending directories when an empty descendant read ${outcome}`, async () => {
      const token = { isCancellationRequested: false };
      const reads: string[] = [];
      const fs: SizeFs = {
        async stat() { return { type: FileType.Directory, size: 0 }; },
        async readDirectory(path) {
          reads.push(path);
          if (path === '/') {
            return [
              { path: '/pending', type: FileType.Directory },
              { path: '/cancel', type: FileType.Directory },
            ];
          }
          token.isCancellationRequested = true;
          if (rejects) {
            throw new Error('EACCES');
          }
          return [];
        },
      };
      await assert.rejects(() => getEntrySize(fs, '/', token), SizeCancelledError);
      assert.deepEqual(reads, ['/', '/cancel']);
    });
  }

  it('prioritizes cancellation over a rejected root stat', async () => {
    const token = { isCancellationRequested: false };
    const fs: SizeFs = {
      async stat() {
        token.isCancellationRequested = true;
        throw new Error('ENOENT');
      },
      async readDirectory() { assert.fail('must not read after cancellation'); },
    };
    await assert.rejects(() => getEntrySize(fs, '/', token), SizeCancelledError);
  });

  it('does not start another read when a progress callback cancels', async () => {
    const token = { isCancellationRequested: false };
    const stats: string[] = [];
    const fs: SizeFs = {
      async stat(path) {
        stats.push(path);
        return { type: path === '/' ? FileType.Directory : FileType.File, size: 1 };
      },
      async readDirectory() {
        return ['first', 'next'].map((name) => ({ path: `/${name}`, type: FileType.File }));
      },
    };
    await assert.rejects(
      () => getEntrySize(fs, '/', token, {
        onProgress() { token.isCancellationRequested = true; },
      }),
      SizeCancelledError,
    );
    assert.deepEqual(stats, ['/', '/first']);
  });

  it('checks cancellation after the final progress callback', async () => {
    const token = { isCancellationRequested: false };
    const fs = mockFs({ type: FileType.File, size: 42 });
    await assert.rejects(
      () => getEntrySize(fs, '/', token, {
        onProgress() { token.isCancellationRequested = true; },
      }),
      SizeCancelledError,
    );
  });
});

describe('size progress', () => {
  it('reports throttled progress inside a flat directory and a final snapshot', async (t) => {
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    const snapshots: SizeResult[] = [];
    const reportsSeenBeforeStat: number[] = [];
    const fs: SizeFs = {
      async stat(path) {
        if (path === '/') {
          return { type: FileType.Directory, size: 0 };
        }
        reportsSeenBeforeStat.push(snapshots.length);
        now = (Number(path.slice(1)) - 1) * 50;
        return { type: FileType.File, size: 10 };
      },
      async readDirectory() {
        return [1, 2, 3, 4].map((n) => ({ path: `/${n}`, type: FileType.File }));
      },
    };
    const result = await getEntrySize(fs, '/', undefined, {
      onProgress(partial) { snapshots.push(partial); },
    });

    assert.deepEqual(reportsSeenBeforeStat, [0, 1, 1, 2]);
    assert.deepEqual(snapshots, [
      { bytes: 10, fileCount: 1, dirCount: 0, skippedCount: 0 },
      { bytes: 30, fileCount: 3, dirCount: 0, skippedCount: 0 },
      { bytes: 40, fileCount: 4, dirCount: 0, skippedCount: 0 },
    ]);
    assert.deepEqual(result, snapshots[2]);
    assert.notEqual(snapshots[0], snapshots[1]);
    assert.notEqual(result, snapshots[2]);
    snapshots[2].bytes = 999;
    assert.equal(result.bytes, 40);
    assert.equal(snapshots[0].bytes, 10);
  });

  it('reports final totals including empty directories and unreadable entries', async (t) => {
    t.mock.method(Date, 'now', () => 0);
    const snapshots: SizeResult[] = [];
    const fs: SizeFs = {
      async stat(path) {
        if (path === '/') {
          return { type: FileType.Directory, size: 0 };
        }
        throw new Error('ENOENT');
      },
      async readDirectory(path) {
        return path === '/' ? [
          { path: '/empty', type: FileType.Directory },
          { path: '/missing', type: FileType.File },
        ] : [];
      },
    };
    const result = await getEntrySize(fs, '/', undefined, {
      onProgress(partial) { snapshots.push(partial); },
    });
    assert.deepEqual(result, { bytes: 0, fileCount: 0, dirCount: 1, skippedCount: 1 });
    assert.deepEqual(snapshots[snapshots.length - 1], result);
    assert.notEqual(snapshots[snapshots.length - 1], result);
  });
});
