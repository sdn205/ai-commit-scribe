import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { GitService, isIndexStaged, isStagedStatus } from './gitService';
import { GitBlameAnalyzer } from './gitBlameAnalyzer';
import { generateCommitMessage } from './aiService';
import { GitRepositoryProvider } from './gitRepository';
import { mapLimit } from '../utils/concurrency';
import { CommitInputWriter } from './commitInputWriter';

// 即使依赖忽略取消信号，也要及时结束界面的进度任务。
function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const aborted = (): void => reject(signal.reason ?? new Error('生成已取消'));
        signal.addEventListener('abort', aborted, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
        if (signal.aborted) {aborted();}
    });
}

export class CommitWorkflow {
    private static readonly active = new Map<string, AbortController>();
    static syncGenerationContext(): void {
        void vscode.commands.executeCommand('setContext', 'commitscribe.generating', this.active.size > 0);
    }
    static cancelGeneration(): void {
        for (const [repoPath, task] of this.active) {
            task.abort();
            if (this.active.get(repoPath) === task) {this.active.delete(repoPath);}
            Logger.log('已取消生成：' + repoPath);
        }
        this.syncGenerationContext();
    }
    static async generateAndSetCommitMessage(source?: vscode.SourceControl): Promise<void> {
        let repoPath: string | undefined;
        let controller: AbortController | undefined;
        try {
            await GitService.initialize();
            const repos = await GitRepositoryProvider.getRepositories();
            const repo = source?.rootUri ? repos.find(r => r.rootUri?.fsPath === source.rootUri?.fsPath) : await GitRepositoryProvider.getActiveRepository();
            if (!repo?.rootUri) {throw new Error('未找到对应的 Git 仓库。');}
            repoPath = repo.rootUri.fsPath;
            const previous = this.active.get(repoPath);
            if (previous) {
                Logger.log('此仓库正在生成，可点击停止按钮取消：' + repoPath);
                return;
            }
            controller = new AbortController();
            this.active.set(repoPath, controller);
            this.syncGenerationContext();
            const signal = controller.signal;
            const inputWriter = new CommitInputWriter(repo.inputBox);
            const onText = (text: string): void => {
                if (signal.aborted || this.active.get(repoPath!) !== controller) {return;}
                inputWriter.write(text);
            };
            await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title: 'AICommitScribe' }, async (progress) => {
                    signal.throwIfAborted();
                    progress.report({ message: '正在分析改动…' });
                    const run = async (): Promise<void> => {
                    Logger.log('开始分析改动：' + repoPath);
                    const files = await GitService.getChangedFiles(repoPath!, signal);
                    signal.throwIfAborted();
                    const staged = files.some(file => isIndexStaged(file.status));
                    const diff = await GitService.getDiff(repoPath!, staged, signal);
                    signal.throwIfAborted();
                    if (!diff) {throw new Error(staged ? '没有可分析的已暂存改动。' : '没有可分析的改动。');}
                    const changed = staged ? files.filter(file => isStagedStatus(file.status)) : files;
                    const hasHead = await GitService.hasHead(repoPath!, signal);
                    signal.throwIfAborted();
                    const analyses = await mapLimit(changed, 8, file => GitBlameAnalyzer.analyzeChanges(repoPath!, file.path, file.status, staged, hasHead, signal), signal);
                    signal.throwIfAborted();
                    Logger.log('开始请求提交说明：' + repoPath);
                    const message = await generateCommitMessage(diff, analyses.filter(Boolean).join('\n\n'), progress, { signal, onText });
                    signal.throwIfAborted();
                    if (inputWriter.userEdited) {
                        Logger.log('保留生成期间手动修改的提交说明：' + repoPath);
                        return;
                    }
                    repo.inputBox.value = message;
                    Logger.log('提交说明已生成：' + repoPath);
                    };
                    await cancellable(run(), signal);
            });
        } catch (error) {
            if (controller?.signal.aborted || (error instanceof Error && error.name === 'NoRepositorySelectedError')) {return;}
            // 通知关闭前不会完成，不能等待它而占用仓库生成锁。
            Logger.error('生成提交说明失败', error instanceof Error ? error : undefined);
            void Logger.showError(error instanceof Error ? error.message : '生成提交说明失败。');
        } finally {
            if (repoPath && controller && this.active.get(repoPath) === controller) {
                this.active.delete(repoPath);
                this.syncGenerationContext();
                Logger.log('生成状态已释放：' + repoPath);
            }
        }
    }
}
