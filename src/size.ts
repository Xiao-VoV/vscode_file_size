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
  /** Files whose size was successfully read. */
  fileCount: number;
  /** Successfully enumerated directories, excluding the selected root. */
  dirCount: number;
  /** Unreadable descendant entries; an unreadable subtree counts once. */
  skippedCount: number;
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

async function readWithCancellation<T>(
  read: () => Promise<T>,
  token?: CancellationTokenLike,
): Promise<T> {
  throwIfCancelled(token);
  try {
    return await read();
  } finally {
    // Cancellation wins even when the pending filesystem operation rejects.
    throwIfCancelled(token);
  }
}

/**
 * Compute the total size of a file or directory.
 *
 * Symbolic links are never followed: they are skipped entirely so that cycles
 * cannot cause infinite loops and link targets are not double-counted.
 * Root failures propagate; unreadable descendants produce a partial result.
 * Cancellation is checked around every filesystem operation and before return.
 */
export async function getEntrySize<T>(
  fs: SizeFs<T>,
  path: T,
  token?: CancellationTokenLike,
  options: SizeOptions = {},
): Promise<SizeResult> {
  const result: SizeResult = { bytes: 0, fileCount: 0, dirCount: 0, skippedCount: 0 };
  let lastReport = -Infinity;

  function reportProgress(final = false): void {
    throwIfCancelled(token);
    if (options.onProgress) {
      const now = Date.now();
      if (final || now - lastReport >= 100) {
        lastReport = now;
        options.onProgress({ ...result });
      }
    }
  }

  function finish(): SizeResult {
    reportProgress(true);
    throwIfCancelled(token);
    return { ...result };
  }

  const root = await readWithCancellation(() => fs.stat(path), token);
  if (isSymlink(root.type)) {
    return finish();
  }
  if (!isDirectory(root.type)) {
    result.bytes = root.size;
    result.fileCount = 1;
    return finish();
  }

  const stack = [{ path, isRoot: true }];

  while (stack.length > 0) {
    throwIfCancelled(token);
    const current = stack.pop()!;
    let entries: DirectoryEntry<T>[];
    try {
      entries = await readWithCancellation(() => fs.readDirectory(current.path), token);
    } catch (err) {
      if (err instanceof SizeCancelledError || current.isRoot) {
        throw err;
      }
      result.skippedCount += 1;
      reportProgress();
      continue;
    }
    if (!current.isRoot) {
      result.dirCount += 1;
    }

    for (const entry of entries) {
      throwIfCancelled(token);
      if (!isSymlink(entry.type)) {
        if (isDirectory(entry.type)) {
          stack.push({ path: entry.path, isRoot: false });
        } else {
          let stat: SizeEntry | undefined;
          try {
            stat = await readWithCancellation(() => fs.stat(entry.path), token);
          } catch (err) {
            if (err instanceof SizeCancelledError) {
              throw err;
            }
            result.skippedCount += 1;
          }
          if (stat && !isSymlink(stat.type)) {
            result.fileCount += 1;
            result.bytes += stat.size;
          }
        }
      }
      reportProgress();
    }
    reportProgress();
  }

  return finish();
}
