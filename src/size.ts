/**
 * Core directory/file size computation.
 *
 * This module is intentionally framework-agnostic (no `vscode` import) so it
 * can be unit tested against a mock filesystem. The extension host adapts
 * `vscode.workspace.fs` into the `SizeFs` interface below.
 */

export const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
} as const;

export interface SizeEntry {
  size: number;
  type: number;
}

export interface DirectoryEntry<T = string> {
  /** Full path of the child entry. */
  path: T;
  type: number;
}

export interface SizeFs<T = string> {
  stat(path: T): Promise<SizeEntry>;
  readDirectory(path: T): Promise<DirectoryEntry<T>[]>;
}

export interface CancellationTokenLike {
  isCancellationRequested: boolean;
}

export interface SizeResult {
  bytes: number;
  fileCount: number;
  dirCount: number;
}

export interface SizeOptions {
  /** Called periodically (throttled) while walking a directory. */
  onProgress?: (partial: SizeResult) => void;
}

export class SizeCancelledError extends Error {
  constructor() {
    super('size computation cancelled');
    this.name = 'SizeCancelledError';
  }
}

function isDirectory(type: number): boolean {
  return (type & FileType.Directory) !== 0;
}

function isSymlink(type: number): boolean {
  return (type & FileType.SymbolicLink) !== 0;
}

function throwIfCancelled(token?: CancellationTokenLike): void {
  if (token?.isCancellationRequested) {
    throw new SizeCancelledError();
  }
}

async function safeStat<T>(fs: SizeFs<T>, path: T): Promise<SizeEntry | null> {
  try {
    return await fs.stat(path);
  } catch {
    // E.g. permission denied or a path that disappeared mid-walk.
    return null;
  }
}

async function safeReadDirectory<T>(
  fs: SizeFs<T>,
  path: T,
): Promise<DirectoryEntry<T>[] | null> {
  try {
    return await fs.readDirectory(path);
  } catch {
    return null;
  }
}

/**
 * Compute the total size of a file or directory.
 *
 * Symbolic links are never followed: they are skipped entirely so that cycles
 * cannot cause infinite loops and link targets are not double-counted.
 * Cancellation is checked before the root stat and before every entry.
 */
export async function getEntrySize<T>(
  fs: SizeFs<T>,
  path: T,
  token?: CancellationTokenLike,
  options: SizeOptions = {},
): Promise<SizeResult> {
  throwIfCancelled(token);

  const root = await safeStat(fs, path);
  if (!root) {
    return { bytes: 0, fileCount: 0, dirCount: 0 };
  }
  if (isSymlink(root.type)) {
    return { bytes: 0, fileCount: 0, dirCount: 0 };
  }
  if (!isDirectory(root.type)) {
    return { bytes: root.size, fileCount: 1, dirCount: 0 };
  }

  let bytes = 0;
  let fileCount = 0;
  let dirCount = 0;
  const stack: T[] = [path];
  let lastReport = 0;

  while (stack.length > 0) {
    const current = stack.pop() as T;
    const entries = await safeReadDirectory(fs, current);
    if (!entries) {
      continue;
    }

    for (const entry of entries) {
      throwIfCancelled(token);
      if (isSymlink(entry.type)) {
        continue;
      }
      if (isDirectory(entry.type)) {
        dirCount += 1;
        stack.push(entry.path);
      } else {
        fileCount += 1;
        const stat = await safeStat(fs, entry.path);
        if (stat) {
          bytes += stat.size;
        }
      }
    }

    if (options.onProgress) {
      const now = Date.now();
      if (now - lastReport > 100) {
        lastReport = now;
        options.onProgress({ bytes, fileCount, dirCount });
      }
    }
  }

  return { bytes, fileCount, dirCount };
}