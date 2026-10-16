import { readCommitStream } from './scribeStream';
interface CommitPrompt { system: string; user: string }

export type ApiFormat = 'responses' | 'chat';
export interface ScribeRequest {
    url: string; model: string; key?: string; format: ApiFormat;
    maxOutputTokens: number; temperature: number; timeout: number;
    reasoningEffort?: string;
    stream?: boolean;
}
interface OutputPart { type?: string; text?: string; refusal?: string }
interface ApiResponse {
    status?: string; error?: { message?: string }; incomplete_details?: { reason?: string };
    output?: Array<{ type?: string; role?: string; content?: OutputPart[] }>;
    output_text?: string;
    choices?: Array<{ finish_reason?: string; message?: { content?: string | OutputPart[]; refusal?: string } }>;
}

export function resolveEndpoint(raw: string, format: ApiFormat): string {
    let url: URL;
    try { url = new URL(raw.trim()); } catch { throw new Error('请填写有效的 API URL。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('API URL 必须使用 HTTP 或 HTTPS；请在密钥输入框中设置凭据。');
    }
    const path = url.pathname.replace(/\/+$/, '');
    const suffix = format === 'responses' ? '/responses' : '/chat/completions';
    url.pathname = /\/(responses|chat\/completions)$/.test(path)
        ? path.replace(/\/(responses|chat\/completions)$/, suffix) : path + suffix;
    url.hash = '';
    return url.toString();
}

export function buildPayload(config: ScribeRequest, prompt: CommitPrompt): Record<string, unknown> {
    if (!config.model.trim()) {throw new Error('请先填写模型 ID。');}
    if (!['responses', 'chat'].includes(config.format)) {throw new Error('不支持的 API 请求格式。');}
    const rawEffort = config.reasoningEffort?.trim() ?? '';
    const effort = ['默认', 'default'].includes(rawEffort.toLowerCase()) ? '' : rawEffort;
    const common = { model: config.model.trim(), stream: config.stream ?? true,
        ...(config.temperature >= 0 ? { temperature: config.temperature } : {}) };
    if (config.format === 'responses') {return { ...common,
        ...(effort ? { reasoning: { effort } } : {}),
        ...(prompt.system ? { instructions: prompt.system } : {}),
        input: [{ role: 'user', content: [{ type: 'input_text', text: prompt.user }] }],
        max_output_tokens: config.maxOutputTokens, store: false,
    };}
    return { ...common,
        ...(effort ? { reasoning_effort: effort } : {}),
        messages: [...(prompt.system ? [{ role: 'system', content: prompt.system }] : []),
            { role: 'user', content: prompt.user }],
        max_completion_tokens: config.maxOutputTokens,
    };
}

export function parseMessage(data: ApiResponse, format: ApiFormat): string {
    if (!data || typeof data !== 'object') {throw new Error('接口返回的 JSON 无效。');}
    if (data.error) {throw new Error('接口返回错误：' + (data.error.message ?? '未知错误'));}
    let message: string;
    if (format === 'responses') {
        if (data.status && data.status !== 'completed') {
            throw new Error('生成尚未完成（' + data.status + '）：' +
                (data.incomplete_details?.reason ?? '请检查接口状态或增加输出预算') + '。');
        }
        const parts = (data.output ?? []).filter(o => o.type === 'message' && (!o.role || o.role === 'assistant'))
            .flatMap(o => o.content ?? []);
        if (parts.some(p => p.type === 'refusal')) {throw new Error('模型拒绝生成提交说明。');}
        message = parts.filter(p => p.type === 'output_text').map(p => p.text ?? '').join('\n');
        if (!message && typeof data.output_text === 'string') {message = data.output_text;}
    } else {
        const choice = data.choices?.[0];
        if (choice?.finish_reason === 'length') {throw new Error('模型输出被截断，请增加最大输出 token 数。');}
        if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) {throw new Error('模型拒绝生成提交说明。');}
        const content = choice?.message?.content;
        message = typeof content === 'string' ? content : (content ?? []).filter(p => p.type === 'text').map(p => p.text ?? '').join('\n');
    }
    if (!message?.trim()) {throw new Error('接口没有返回可用的提交说明，请检查请求格式和模型 ID。');}
    return message.trim();
}

export async function requestCommit(config: ScribeRequest, prompt: CommitPrompt, signal?: AbortSignal,
    onText?: (text: string) => void): Promise<string> {
    const streaming = config.stream ?? true;
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {abort();}
    const timer = config.timeout === -1 ? undefined : setTimeout(() =>
        controller.abort(new Error('请求超时，请增加 API 请求超时设置。')), config.timeout * 1000);
    try {
        const response = await fetch(resolveEndpoint(config.url, config.format), {
            method: 'POST', headers: {
                'content-type': 'application/json',
                Accept: streaming ? 'text/event-stream' : 'application/json',
                ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}),
            },
            body: JSON.stringify(buildPayload(config, prompt)), signal: controller.signal,
        });
        if (!response.ok) {throw new Error(`接口请求失败（HTTP ${response.status}）：${(await response.text()).slice(0, 1000)}`);}
        // 兼容声明流式请求却返回普通 JSON 的服务。
        if (!streaming || response.headers.get('content-type')?.includes('application/json')) {
            const message = parseMessage(await response.json() as ApiResponse, config.format);
            controller.signal.throwIfAborted();
            if (streaming) {onText?.(message);}
            return message;
        }
        return await readCommitStream(response, config.format, controller.signal, onText);
    } catch (error) {
        if (controller.signal.aborted) {throw controller.signal.reason;}
        throw error;
    } finally {
        if (timer !== undefined) {clearTimeout(timer);}
        signal?.removeEventListener('abort', abort);
    }
}
