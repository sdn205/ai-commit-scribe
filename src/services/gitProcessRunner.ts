import * as vscode from 'vscode';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { Logger } from '../utils/logger';
import { ConfigService } from '../utils/configService';
import { buildGitEnv } from '../utils/gitEnv';

let cachedGitPath: string | undefined;
function resolveGitPath(): string {
  if (cachedGitPath !== undefined) {
    return cachedGitPath;
  }
  try {
    const configured = vscode.workspace.getConfiguration('git').get<string | string[]>('path');
    let candidates: string[] = [];
    if (Array.isArray(configured)) {
      candidates = configured;
    } else if (configured) {
      candidates = [configured];
    }
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && path.isAbsolute(candidate)) {
        cachedGitPath = candidate;
        return candidate;
      }
    }
    const gitApi = vscode.extensions.getExtension('vscode.git')?.exports?.getAPI?.(1);
    const apiPath: unknown = gitApi?.git?.path;
    if (typeof apiPath === 'string' && path.isAbsolute(apiPath)) {
      cachedGitPath = apiPath;
      return apiPath;
    }
  } catch {
  }
  cachedGitPath = 'git';
  return 'git';
}

if (typeof vscode.workspace?.onDidChangeConfiguration === 'function') {
  vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('git.path')) {
      cachedGitPath = undefined;
      Logger.log('git.path changed — invalidating cached git path');
    }
  });
}

// 在后续差异截断前限制进程输出，避免大型生成文件耗尽内存。
const GIT_OUTPUT_BUFFER_CAP = 200_000;

export class GitProcessRunner {
  static async execGit(
    args: string[],
    cwd: string,
    options: { signal?: AbortSignal; allowNonZeroExit?: boolean } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const timeoutSeconds = ConfigService.get('gitTimeout');
      const timeoutMs =
        timeoutSeconds === -1 ? undefined : timeoutSeconds * 1000;

      const child = spawn(resolveGitPath(), args, {
        cwd,
        env: buildGitEnv(),
        timeout: timeoutMs,
      });
      // 通过流解码器保留跨块的 UTF-8 字节，避免中文乱码。
      child.stdout.setEncoding('utf-8');
      child.stderr.setEncoding('utf-8');

      let stdout = '';
      let stderr = '';
      let aborted = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const onAbort = (): void => {
        aborted = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 1500);
        killTimer.unref?.();
      };

      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      let bufferOverflowed = false;
      child.stdout.on('data', (data: string) => {
        if (stdout.length >= GIT_OUTPUT_BUFFER_CAP) {
          if (!bufferOverflowed) {
            bufferOverflowed = true;
            child.kill('SIGTERM');
          }
          return;
        }
        stdout += data;
      });

      child.stderr.on('data', (data: string) => {
        if (stderr.length >= GIT_OUTPUT_BUFFER_CAP) {
          return;
        }
        stderr += data;
      });

      child.on('error', (err: Error) => {
        if (options.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
        if (killTimer) {
          clearTimeout(killTimer);
        }
        reject(err);
      });

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (options.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
        if (killTimer) {
          clearTimeout(killTimer);
        }
        if (aborted) {
          reject(new Error('Git command cancelled'));
          return;
        }
        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          if (bufferOverflowed) {
            resolve({
              stdout: stdout.slice(0, GIT_OUTPUT_BUFFER_CAP),
              stderr,
              exitCode: -1,
            });
            return;
          }
          reject(
            new Error(
              `Git command timed out after ${timeoutSeconds}s: git ${args[0] ?? ''}. Increase commitSage.gitTimeout if this is a slow operation.`,
            ),
          );
          return;
        }
        const exitCode = code ?? -1;
        if (code === 0 || options.allowNonZeroExit) {
          resolve({ stdout, stderr, exitCode });
        } else {
          reject(
            new Error(`Git command failed with code ${code}: ${stderr}`),
          );
        }
      });
    });
  }
}
