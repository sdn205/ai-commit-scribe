import { ConfigService } from '../utils/configService';
import type { Progress } from 'vscode';
import { truncateDiff } from '../utils/diffTruncation';
import { requestCommit } from './scribeApi';
import { ScribeSecrets } from './scribeSecrets';
import { ScribeProfiles } from './scribeProfiles';

export async function generateCommitMessage(diff: string, blame: string,
    progress: Progress<{ message?: string }>, context: { signal: AbortSignal; onText: (text: string) => void }): Promise<string> {
    if (!diff) {throw new Error('没有可用于生成提交说明的改动。');}
    const profile = ScribeProfiles.active();
    const key = await ScribeSecrets.get(profile.id);
    const limit = ConfigService.get('general.maxDiffSize');
    const parts = ['待分析的 Git diff：\n' + truncateDiff(diff, limit === -1 ? Infinity : Math.max(1000, Math.min(1000000, limit)))];
    if (blame.trim()) {parts.push('Git blame 分析：\n' + blame);}
    const prompt = { system: ConfigService.get('commit.systemPrompt'), user: parts.join('\n\n') };
    context.signal.throwIfAborted();
    progress.report({ message: '正在生成提交说明…' });
    return requestCommit({
        url: profile.url, model: profile.model, key, format: profile.format,
        reasoningEffort: profile.reasoningEffort,
        stream: ConfigService.get('general.stream'),
        temperature: ConfigService.get('general.temperature'),
        maxOutputTokens: ConfigService.get('general.maxOutputTokens'),
        timeout: ConfigService.get('apiRequestTimeout'),
    }, prompt, context.signal, context.onText);
}
