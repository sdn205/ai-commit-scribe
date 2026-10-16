import type { ApiFormat } from './scribeApi';

// 网络分块可能截断 SSE 帧或 UTF-8 字符，分别缓冲后再解析。
export async function readCommitStream(response: Response, format: ApiFormat, signal: AbortSignal,
    onText?: (text: string) => void): Promise<string> {
    if (!response.body) {throw new Error('接口没有返回响应流。');}
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let complete = false;
    const append = (delta: unknown): void => {
        if (typeof delta !== 'string' || !delta) {return;}
        text += delta;
        onText?.(text);
    };
    const frame = (raw: string): void => {
        const lines = raw.split(/\r?\n/);
        const data = lines.filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) {return;}
        if (data === '[DONE]') {return;}
        const event = JSON.parse(data);
        if (event.error || event.type === 'error') {
            throw new Error('接口返回错误：' + (event.error?.message ?? event.message ?? '未知错误'));
        }
        if (format === 'chat') {
            const choice = event.choices?.find((item: { index?: number }) => item.index === 0 || item.index === undefined);
            if (!choice) {return;}
            if (choice.delta?.refusal || choice.finish_reason === 'content_filter') {throw new Error('模型拒绝生成提交说明。');}
            append(choice.delta?.content);
            if (choice.finish_reason === 'length') {throw new Error('模型输出被截断，请增加最大输出 token 数。');}
            if (choice.finish_reason) {
                if (choice.finish_reason !== 'stop') {throw new Error('模型未返回完整提交说明：' + choice.finish_reason);}
                complete = true;
            }
        } else {
            const type = event.type ?? lines.find(line => line.startsWith('event:'))?.slice(6).trim();
            if (type === 'response.output_text.delta') {append(event.delta);}
            if (type === 'response.refusal.delta' || type === 'response.refusal.done') {throw new Error('模型拒绝生成提交说明。');}
            if (type === 'response.failed' || type === 'response.incomplete') {
                throw new Error('生成未完成：' + (event.response?.error?.message ?? event.response?.incomplete_details?.reason ?? type));
            }
            if (type === 'response.completed') {
                const result = event.response;
                if (result?.error || (result?.status && result.status !== 'completed')) {throw new Error('生成未完成。');}
                const parts = (result?.output ?? []).filter((item: { type?: string }) => item.type === 'message')
                    .flatMap((item: { content?: Array<{ type?: string; text?: string }> }) => item.content ?? []);
                if (parts.some((part: { type?: string }) => part.type === 'refusal')) {throw new Error('模型拒绝生成提交说明。');}
                // 结束事件携带完整文本，不能追加到已收到的增量后面。
                const finalText = parts.filter((part: { type?: string }) => part.type === 'output_text')
                    .map((part: { text?: string }) => part.text ?? '').join('\n') || result?.output_text;
                if (typeof finalText === 'string' && finalText !== text) {text = finalText; onText?.(text);}
                complete = true;
            }
        }
    };
    try {
        while (!complete) {
            signal.throwIfAborted();
            const { value, done } = await reader.read();
            signal.throwIfAborted();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            let separator: RegExpExecArray | null;
            while ((separator = /\r?\n\r?\n/.exec(buffer))) {
                const raw = buffer.slice(0, separator.index);
                buffer = buffer.slice(separator.index + separator[0].length);
                frame(raw);
                if (complete) {break;}
            }
            if (done) {if (!complete && buffer.trim()) {frame(buffer);} break;}
        }
        if (!complete) {throw new Error('连接提前结束，提交说明未生成完整。');}
        if (!text.trim()) {throw new Error('接口没有返回可用的提交说明。');}
        return text.trim();
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}
