import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { Logger } from '../utils/logger';
import { isDeletedStatus, isNewStatus } from './gitService';
import { GitProcessRunner } from './gitProcessRunner';
import { toError } from '../utils/errorUtils';
import {
  analyzeBlameInfo,
  formatAnalysis,
  parseBlameOutput,
  parseChangedLines,
} from './gitBlameParser';

export class GitBlameAnalyzer {
  static async analyzeChanges(
    repoPath: string,
    filePath: string,
    knownStatus: string,
    useStagedChanges: boolean,
    hasHead: boolean,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const normalizedPath = path.normalize(filePath.replace(/^\/+/, ''));

      if (isDeletedStatus(knownStatus)) {
        Logger.log(`Skipping blame analysis for deleted file: ${normalizedPath}`);
        return `Deleted file: ${normalizedPath}`;
      }

      if (isNewStatus(knownStatus)) {
        Logger.log(`Skipping blame analysis for new file: ${normalizedPath}`);
        return `New file: ${normalizedPath}`;
      }

      const absoluteFilePath = path.resolve(repoPath, normalizedPath);
      try {
        await fs.access(absoluteFilePath);
      } catch {
        throw new Error(`File not found: ${absoluteFilePath}`);
      }
      if (!hasHead) {
        throw new Error('Repository has no commits yet');
      }

      const { stdout: blameOutput } = await GitProcessRunner.execGit(
        ['blame', '--line-porcelain', '--', normalizedPath],
        repoPath,
        { signal },
      );
      const blame = parseBlameOutput(blameOutput);
      const diffArgs = useStagedChanges
        ? ['diff', '--cached', '--unified=0', '--', normalizedPath]
        : ['diff', '--unified=0', '--', normalizedPath];
      const { stdout: diff } = await GitProcessRunner.execGit(diffArgs, repoPath, {
        signal,
      });
      const changedLines = parseChangedLines(diff);
      const authorChanges = analyzeBlameInfo(blame, changedLines);
      return formatAnalysis(authorChanges);
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      Logger.error('Error analyzing changes:', toError(error));
      return '';
    }
  }
}
