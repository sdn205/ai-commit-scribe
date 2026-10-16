export const DEFAULT_SYSTEM_PROMPT = `你是一名 Git 提交说明助手，请根据提供的代码差异，用简体中文生成一条准确、简洁的提交说明。

规则：
1. 使用 Conventional Commits 格式：type(可选 scope): summary。
2. 根据实际改动选择 feat、fix、refactor、perf、docs、test、build、ci、chore 或 revert。
3. 标题简洁概括改动，通常不超过 50 个字符。小改动只写标题。
4. 必要时添加正文，以 - 开头列出关键点，最多 5 条，每条尽量不超过 50 个字符。
5. 说明改动的目的或效果，避免逐行复述差异或罗列所有文件。
6. 只输出一条提交说明，不要开场白、解释、结束语、Markdown 标题、加粗或代码块。
7. 不编造代码差异中无法确认的功能、测试结果或修复效果。` ;

export const SCRIBE_SETTINGS = {
    'api.url': { type: 'string', default: '', description: '接口基础地址或完整请求 URL。基础地址会按请求格式追加 /responses 或 /chat/completions。' },
    'api.model': { type: 'string', default: '', description: '服务端提供的模型 ID，手动填写。' },
    'api.reasoningEffort': { type: 'string', default: '', description: '留空、默认或 default 表示不发送；也可自行填写 high、xhigh 等接口支持的单词，不限制档位。' },
    'api.format': { type: 'string', default: 'responses', enum: ['responses', 'chat'], enumDescriptions: ['Responses API', 'Chat Completions API'], description: '请求与响应使用的协议。' },
    'commit.systemPrompt': { type: 'string', default: DEFAULT_SYSTEM_PROMPT, editPresentation: 'multilineText', description: '完整系统提示词。编辑后原样发送，不再追加隐藏的字数或格式规则。留空表示不发送系统提示词。' },
    'apiRequestTimeout': { type: 'number', default: 60, minimum: -1, description: 'API 请求超时（秒），-1 表示不限制。' },
    'gitTimeout': { type: 'number', default: 120, minimum: -1, description: 'Git 操作超时（秒），-1 表示不限制。' },
    'general.maxDiffSize': { type: 'number', default: 100000, minimum: -1, description: '发送的差异最大字符数；-1 表示不截断，正数范围为 1000 至 1000000。' },
    'general.stream': { type: 'boolean', default: true, description: '开启后边生成边填入提交说明；关闭后等待完整结果，再一次性填入。下一次生成生效。' },
    'general.temperature': { type: 'number', default: -1, minimum: -1, maximum: 2, description: '采样温度，-1 表示不发送该参数，使用模型默认值。' },
    'general.maxOutputTokens': { type: 'number', default: 4096, minimum: 1, maximum: 131072, description: '最大输出 token 数，包括推理模型的思考预算。' },
} as const;
export type ScribeSettingKey = keyof typeof SCRIBE_SETTINGS;
export type ScribeValue = string | number | boolean;
export interface ScribeProfile {
    id: string;
    name: string;
    url: string;
    model: string;
    format: 'responses' | 'chat';
    reasoningEffort?: string;
}
export type ProfileAction = { type: 'switch'; id: string } | { type: 'create' | 'rename' | 'delete' };
export interface ScribeState {
    settings: Record<ScribeSettingKey, ScribeValue>;
    pinned: string[];
    hasApiKey: boolean;
    profileId: string;
    profiles: Array<Pick<ScribeProfile, 'id' | 'name'>>;
}
export type ScribeIncoming =
    | { type: 'getState' }
    | { type: 'saveSettings'; requestId: number; profileId: string; settings: Partial<Record<ScribeSettingKey, ScribeValue>>; apiKey?: string; removeApiKey?: boolean; profileAction?: ProfileAction };

export function validateSetting(key: string, value: unknown): key is ScribeSettingKey {
    const spec = SCRIBE_SETTINGS[key as ScribeSettingKey];
    if (!spec || typeof value !== spec.type) {return false;}
    if ('enum' in spec && !(spec.enum as readonly unknown[]).includes(value)) {return false;}
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {return false;}
        if (key !== 'general.temperature' && !Number.isInteger(value)) {return false;}
        if ('minimum' in spec && value < spec.minimum) {return false;}
        if ('maximum' in spec && value > spec.maximum) {return false;}
        if (['apiRequestTimeout', 'gitTimeout'].includes(key) && value !== -1 && (value < 1 || value > 86400)) {return false;}
        if (key === 'general.maxDiffSize' && value !== -1 && (value < 1000 || value > 1000000)) {return false;}
        if (key === 'general.temperature' && value !== -1 && value < 0) {return false;}
    }
    return true;
}
