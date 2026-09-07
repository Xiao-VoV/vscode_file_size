import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DirectoryEntry,
  FileType,
  getEntrySize,
  SizeCancelledError,
  SizeEntry,
  SizeFs,
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
    assert.deepEqual(result, { bytes: 42, fileCount: 1, dirCount: 0 });
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
    assert.deepEqual(result, { bytes: 60, fileCount: 3, dirCount: 2 });
  });

  it('skips symbolic links entirely', async () => {
    const root: Node = {
      type: FileType.Directory,
      children: {
        'a.txt': { type: FileType.File, size: 10 },
        loop: { type: FileType.SymbolicLink, size: 0 },
      },
    };
    const result = await getEntrySize(mockFs(root), '/');
    assert.deepEqual(result, { bytes: 10, fileCount: 1, dirCount: 0 });

    const linkOnly = await getEntrySize(mockFs(root), '/loop');
    assert.deepEqual(linkOnly, { bytes: 0, fileCount: 0, dirCount: 0 });
  });

  it('returns zero when the root cannot be statted', async () => {
    const root: Node = { type: FileType.Directory, children: {} };
    const result = await getEntrySize(mockFs(root), '/missing');
    assert.deepEqual(result, { bytes: 0, fileCount: 0, dirCount: 0 });
  });

  it('throws SizeCancelledError when cancelled at the root', async () => {
    const root: Node = { type: FileType.Directory, children: {} };
    const token = { isCancellationRequested: true };
    await assert.rejects(
      () => getEntrySize(mockFs(root), '/', token),
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