import { Logger } from '../utils/logger';
import { NoChangesDetectedError } from '../models/errors';
import { toError } from '../utils/errorUtils';
import { unquoteGitPath } from '../utils/gitPath';
import { mapLimit } from '../utils/concurrency';
import { GitProcessRunner } from './gitProcessRunner';
import { GitRepositoryProvider } from './gitRepository';

const GIT_FANOUT_CONCURRENCY = 8;

const STAGED_STATUS_CODES = new Set(['M', 'A', 'D', 'R']);

export class GitService {
  static async initialize(): Promise<void> {
    try {
      Logger.log('Initializing Git service');
      await GitRepositoryProvider.validateGitExtension();
      Logger.log('Git service initialized successfully');
    } catch (error) {
      Logger.error('Failed to initialize Git service:', toError(error));
      throw error;
    }
  }

  private static async listFiles(
    listArgs: string[],
    repoPath: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const output = await this.executeGitCommand(listArgs, repoPath, signal);
    return output
      .split('\n')
      .filter((file) => file.trim())
      .map(unquoteGitPath);
  }

  private static async collectPerFileDiffs(
    files: string[],
    header: string,
    perFileDiff: (file: string) => Promise<string>,
    signal?: AbortSignal,
  ): Promise<string> {
    const diffs = await mapLimit(files, GIT_FANOUT_CONCURRENCY, perFileDiff, signal);
    const validDiffs = diffs.filter((diff) => diff.trim());
    return validDiffs.length > 0 ? header + validDiffs.join('\n') : '';
  }

  private static async enumerateChanges(
    repoPath: string,
    knownHasStagedChanges: boolean,
    signal?: AbortSignal,
  ): Promise<{
    staged: string[];
    unstaged: string[];
    untracked: string[];
    deleted: string[];
  }> {
    const hasHead = await this.hasHead(repoPath, signal);
    const staged = knownHasStagedChanges === false
      ? []
      : await this.listFiles(['diff', '--cached', '--name-only'], repoPath, signal);

    const unstaged = knownHasStagedChanges
      ? []
      : await this.listFiles(['diff', '--name-only'], repoPath, signal);
    const untracked = !knownHasStagedChanges
      ? await this.listFiles(['ls-files', '--others', '--exclude-standard'], repoPath, signal)
      : [];
    const deleted = hasHead && !knownHasStagedChanges
      ? await this.listFiles(['ls-files', '--deleted'], repoPath, signal)
      : [];

    return { staged, unstaged, untracked, deleted };
  }

  private static async collectDiffs(
    repoPath: string,
    changes: {
      unstaged: string[];
      untracked: string[];
      deleted: string[];
    },
    signal?: AbortSignal,
  ): Promise<string[]> {
    const diffs: string[] = [];

    if (changes.unstaged.length > 0) {
      diffs.push(...await this.diffFiles(changes.unstaged, repoPath, ['diff'], '# Unstaged changes:\n', signal));
    }

    if (changes.untracked.length > 0) {
      const untracked = await this.getUntrackedDiff(changes.untracked, repoPath, signal);
      if (untracked) {
        diffs.push(untracked);
      }
    }

    if (changes.deleted.length > 0) {
      const deleted = await this.getDeletedDiff(changes.deleted, repoPath, signal);
      if (deleted) {
        diffs.push(deleted);
      }
    }

    return diffs;
  }

  static async getDiff(
    repoPath: string,
    knownHasStagedChanges: boolean,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const changes = await this.enumerateChanges(
        repoPath,
        knownHasStagedChanges,
        signal,
      );

      if (
        changes.staged.length === 0 &&
        changes.unstaged.length === 0 &&
        changes.untracked.length === 0 &&
        changes.deleted.length === 0
      ) {
        throw new NoChangesDetectedError();
      }

      const renames = changes.staged.length > 0
        ? await this.getStagedRenameMap(repoPath, signal)
        : undefined;

      if (knownHasStagedChanges && changes.staged.length > 0) {
        const staged = await this.diffFiles(changes.staged, repoPath, ['diff', '--cached'], undefined, signal, renames);
        return staged.join('\n\n').trim();
      }

      const diffs = await this.collectDiffs(repoPath, changes, signal);

      const combinedDiff = diffs.join('\n\n').trim();
      if (!combinedDiff) {
        throw new NoChangesDetectedError();
      }

      return combinedDiff;
    } catch (error) {
      if (error instanceof NoChangesDetectedError) {
        throw error;
      }
      const original = toError(error);
      Logger.error('Error getting diff:', original);
      original.message = `Failed to get diff: ${original.message}`;
      throw original;
    }
  }

  private static async isSubmodule(file: string, repoPath: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const { stdout } = await GitProcessRunner.execGit(
        ['ls-files', '--stage', '--', file],
        repoPath,
        { signal },
      );
      return stdout.includes('160000');
    } catch {
      return false;
    }
  }

  // 重命名差异需同时传入新旧路径，否则可能被当成整个文件新增。
  private static async getStagedRenameMap(
    repoPath: string,
    signal?: AbortSignal,
  ): Promise<Map<string, string>> {
    const renames = new Map<string, string>();
    try {
      const output = await this.executeGitCommand(
        ['diff', '--cached', '--name-status', '-M', '-z'],
        repoPath,
        signal,
      );
      const fields = output.split('\0');
      for (let i = 0; i < fields.length; i++) {
        const status = fields[i];
        if (!status) { continue; }
        // 重命名和复制记录包含旧、新两个路径，其余状态只有一个。
        if (status.startsWith('R') || status.startsWith('C')) {
          const from = fields[i + 1];
          const to = fields[i + 2];
          if (from && to) { renames.set(to, from); }
          i += 2;
        } else {
          i += 1;
        }
      }
    } catch (error) {
      if (signal?.aborted) { throw error; }
      Logger.warn(`Failed to read staged renames: ${toError(error).message}`);
    }
    return renames;
  }

  private static async diffFiles(
    files: string[],
    repoPath: string,
    diffArgs: string[],
    prefix?: string,
    signal?: AbortSignal,
    renames?: Map<string, string>,
  ): Promise<string[]> {
    const results = await mapLimit(files, GIT_FANOUT_CONCURRENCY, async (file) => {
      if (await this.isSubmodule(file, repoPath, signal)) {
        return null;
      }
      const renamedFrom = renames?.get(file);
      const fileDiff = await this.executeGitCommand(
        renamedFrom
          ? [...diffArgs, '-M', '--', renamedFrom, file]
          : [...diffArgs, '--', file],
        repoPath,
        signal,
      );
      if (!fileDiff.trim()) {
        return null;
      }
      return prefix ? prefix + fileDiff : fileDiff;
    }, signal);

    return results.filter((d): d is string => d !== null);
  }

  private static async getUntrackedDiff(files: string[], repoPath: string, signal?: AbortSignal): Promise<string> {
    return this.collectPerFileDiffs(files, '# New files:\n', async (file) => {
      try {
        // 存在差异时退出码为 1，允许非零退出以保留正常差异输出。
        const { stdout, exitCode } = await GitProcessRunner.execGit(
          ['diff', '--no-index', '--', '/dev/null', file],
          repoPath,
          { allowNonZeroExit: true, signal },
        );
        return exitCode === 128 ? '' : stdout;
      } catch (error) {
        Logger.error(`Error diffing untracked file ${file}:`, toError(error));
        return '';
      }
    }, signal);
  }

  private static async getDeletedDiff(files: string[], repoPath: string, signal?: AbortSignal): Promise<string> {
    return this.collectPerFileDiffs(files, '# Deleted files:\n', async (file) => {
      try {
        return await this.executeGitCommand(['diff', '--', file], repoPath, signal);
      } catch (error) {
        Logger.error(`Error diffing deleted file ${file}:`, toError(error));
        return '';
      }
    }, signal);
  }

  public static async hasHead(repoPath: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await GitProcessRunner.execGit(['rev-parse', 'HEAD'], repoPath, { signal });
      return true;
    } catch {
      return false;
    }
  }

  static async getChangedFiles(
    repoPath: string,
    signal?: AbortSignal,
  ): Promise<ChangedFile[]> {
    try {
      const statusCommand = ['status', '--porcelain'];
      const output = await this.executeGitCommand(statusCommand, repoPath, signal);

      return output
        .split('\n')
        .filter((line) => line.trim() !== '')
        .filter((line) => {
          const [staged, unstaged] = [line[0], line[1]];
          return staged !== ' ' || unstaged !== ' ';
        })
        .map((line) => {
          const status = line.substring(0, 2);
          let filePath = line.substring(3).trim();

          if (status.startsWith('R')) {
            const renameParts = filePath.split(' -> ');
            filePath = renameParts[1] ?? renameParts[0];
          }

          filePath = unquoteGitPath(filePath);

          return { path: filePath, status };
        });
    } catch (error) {
      Logger.error('Error getting changed files:', toError(error));
      return [];
    }
  }

  private static async executeGitCommand(
    args: string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const { stdout } = await GitProcessRunner.execGit(args, cwd, { signal });
    return stdout;
  }

}

interface ChangedFile {
  path: string;
  status: string;
}

export function isDeletedStatus(status: string): boolean {
  return status === 'D ' || status[1] === 'D';
}

export function isNewStatus(status: string): boolean {
  return status === '??' || status === 'A ';
}

export function isIndexStaged(status: string): boolean {
  const x = status[0];
  return x !== ' ' && x !== '?';
}

export function isStagedStatus(status: string): boolean {
  return STAGED_STATUS_CODES.has(status[0]);
}
