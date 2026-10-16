import { SCRIBE_SETTINGS, ScribeState, ScribeSettingKey, ScribeValue, ScribeIncoming, ProfileAction, validateSetting } from '../../scribeSettings';

declare function acquireVsCodeApi(): {
    postMessage(message: ScribeIncoming): void;
    getState(): { sections?: Record<string, boolean> } | undefined;
    setState(value: { sections: Record<string, boolean> }): void;
};
type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
interface PendingSave {
    requestId: number;
    revisions: Map<ScribeSettingKey, number>;
    keyRevision?: number;
    profileAction?: ProfileAction;
}
const api = acquireVsCodeApi();
const root = document.getElementById('root')!;
const controls = new Map<ScribeSettingKey, Control>();
const hints = new Map<ScribeSettingKey, HTMLElement>();
const dirty = new Map<ScribeSettingKey, number>();
const composing = new Set<Control>();
let current: ScribeState | undefined;
let revision = 0;
let requestId = 0;
let pending: PendingSave | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let keyRevision: number | undefined;
let removeKey = false;
let keyInput: HTMLInputElement;
let removeButton: HTMLButtonElement;
let keyHint: HTMLElement;
let status: HTMLElement;
let profileSelect: HTMLSelectElement;
let profileButtons: HTMLButtonElement[];
let queuedAction: ProfileAction | undefined;
function setBusy(): void {
    root.setAttribute('aria-busy', String(!!pending || !!queuedAction || timer !== undefined));
    const busy = !!queuedAction || !!pending?.profileAction;
    controls.forEach((input, key) => {input.disabled = busy || !!current?.pinned.includes(key);});
    keyInput.disabled = busy;
    removeButton.disabled = busy || (!current?.hasApiKey && keyRevision === undefined && pending?.keyRevision === undefined);
    profileSelect.disabled = busy;
    profileButtons.forEach(button => {button.disabled = busy || (button.id === 'delete-profile' && current?.profileId === 'default');});
}
function requestProfileAction(action: ProfileAction): void {
    if (!current || queuedAction || pending?.profileAction) {return;}
    profileSelect.value = current.profileId;
    if (composing.size) {status.textContent = '请完成当前输入后再切换配置。'; return;}
    queuedAction = action; setBusy(); scheduleSave(true);
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const result = document.createElement(tag);
    if (text !== undefined) {result.textContent = text;}
    return result;
}
function scheduleSave(immediate = false): void {
    if (!current) {return;}
    if (timer !== undefined) {clearTimeout(timer); timer = undefined;}
    status.textContent = '';
    root.setAttribute('aria-busy', 'true');
    if (immediate) {save();}
    else {timer = setTimeout(() => { timer = undefined; save(); }, 450);}
}
function watch(input: Control, changed: () => void): void {
    input.addEventListener('compositionstart', () => { composing.add(input); });
    input.addEventListener('compositionend', () => { composing.delete(input); changed(); scheduleSave(); });
    input.addEventListener('input', () => { changed(); scheduleSave(); });
    input.addEventListener('change', () => { changed(); scheduleSave(true); });
    input.addEventListener('blur', () => scheduleSave(true));
}
function group(id: string, title: string, open = true): HTMLElement {
    const details = element('details');
    details.id = id;
    details.open = api.getState()?.sections?.[id] ?? open;
    details.appendChild(element('summary', title));
    const body = element('div'); body.className = 'body'; details.appendChild(body);
    details.addEventListener('toggle', () => api.setState({ sections: { ...api.getState()?.sections, [id]: details.open } }));
    root.appendChild(details);
    return body;
}
function field(parent: HTMLElement, key: ScribeSettingKey, title: string, rows?: number): void {
    const spec = SCRIBE_SETTINGS[key];
    const label = element('label', title); label.className = 'field'; label.htmlFor = key; parent.appendChild(label);
    let input: Control;
    if ('enum' in spec) {
        const select = element('select');
        spec.enum.forEach((value, index) => { const option = element('option', spec.enumDescriptions[index]); option.value = value; select.appendChild(option); });
        input = select;
    } else if (rows) {
        const textarea = element('textarea'); textarea.rows = rows; textarea.spellcheck = false; input = textarea;
    } else {
        const item = element('input');
        item.type = spec.type === 'boolean' ? 'checkbox' : spec.type === 'number' ? 'number' : 'text';
        if ('minimum' in spec) {item.min = String(spec.minimum);}
        if ('maximum' in spec) {item.max = String(spec.maximum);}
        item.step = key === 'general.temperature' ? '0.1' : '1';
        if (key === 'api.url') {item.placeholder = 'https://你的接口地址/v1';}
        if (key === 'api.model') {item.placeholder = '填写模型 ID';}
        if (key === 'api.reasoningEffort') {item.placeholder = '默认，或填写 high / xhigh 等';}
        input = item;
    }
    input.id = key;
    watch(input, () => { dirty.set(key, ++revision); });
    controls.set(key, input); parent.appendChild(input);
    const hint = element('div', spec.description); hint.className = 'hint'; parent.appendChild(hint); hints.set(key, hint);
}
function render(): void {
    root.replaceChildren();
    const connection = group('connection', '接口配置');
    const profileLabel = element('label', '当前 API 配置'); profileLabel.className = 'field'; profileLabel.htmlFor = 'api-profile'; connection.appendChild(profileLabel);
    profileSelect = element('select'); profileSelect.id = 'api-profile';
    profileSelect.addEventListener('change', () => requestProfileAction({type: 'switch', id: profileSelect.value})); connection.appendChild(profileSelect);
    const actions = element('div'); actions.className = 'scribe-profile-actions';
    profileButtons = [];
    for (const [type, title] of [['create', '新增配置'], ['rename', '重命名'], ['delete', '删除配置']] as const) {
        const button = element('button', title); button.id = type + '-profile';
        button.addEventListener('click', () => requestProfileAction({type})); actions.appendChild(button); profileButtons.push(button);
    }
    connection.appendChild(actions);
    const profileHint = element('div', '切换前自动保存当前编辑。每套接口独立保存；系统提示词和高级设置共用。'); profileHint.className = 'hint'; connection.appendChild(profileHint);
    field(connection, 'api.url', 'API URL');
    const label = element('label', 'API Key'); label.className = 'field'; label.htmlFor = 'api-key'; connection.appendChild(label);
    keyInput = element('input'); keyInput.type = 'password'; keyInput.id = 'api-key'; keyInput.autocomplete = 'off';
    watch(keyInput, () => { keyRevision = ++revision; removeKey = false; }); connection.appendChild(keyInput);
    keyHint = element('div'); keyHint.className = 'hint'; connection.appendChild(keyHint);
    removeButton = element('button', '移除密钥');
    removeButton.addEventListener('click', () => {
        keyInput.value = ''; keyRevision = ++revision; removeKey = true; scheduleSave(true);
    }); connection.appendChild(removeButton);
    field(connection, 'api.model', '模型 ID'); field(connection, 'api.format', '请求格式');
    field(connection, 'api.reasoningEffort', '思考强度');
    const prompt = group('prompt', '系统提示词');
    field(prompt, 'commit.systemPrompt', '系统提示词（完整内容）', 13);
    const advanced = group('advanced', '高级设置', false);
    field(advanced, 'general.stream', '开启流式传输');
    field(advanced, 'apiRequestTimeout', 'API 请求超时（秒）'); field(advanced, 'gitTimeout', 'Git 超时（秒）');
    field(advanced, 'general.maxDiffSize', '差异最大长度（字符）'); field(advanced, 'general.maxOutputTokens', '最大输出 token 数');
    field(advanced, 'general.temperature', '采样温度');
    const footer = element('div'); footer.className = 'scribe-save';
    status = element('span'); status.id = 'save-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    footer.appendChild(status); root.appendChild(footer);
}
function updateState(state: ScribeState): void {
    current = state;
    if (JSON.stringify([...profileSelect.options].map(o => [o.value, o.text])) !== JSON.stringify(state.profiles.map(p => [p.id, p.name]))) {
        profileSelect.replaceChildren(...state.profiles.map(profile => {const option = element('option', profile.name); option.value = profile.id; return option;}));
    }
    profileSelect.value = state.profileId;
    for (const [key, input] of controls) {
        input.disabled = state.pinned.includes(key);
        if (input.disabled) {dirty.delete(key); input.removeAttribute('aria-invalid');}
        if (!dirty.has(key) && !composing.has(input)) {
            if (input instanceof HTMLInputElement && input.type === 'checkbox') {input.checked = Boolean(state.settings[key]);}
            else if (input.value !== String(state.settings[key])) {input.value = String(state.settings[key]);}
            hints.get(key)!.textContent = input.disabled ? '此项由 .commitscribe/config.json 固定，请在该文件中修改。' : SCRIBE_SETTINGS[key].description;
        }
    }
    keyInput.placeholder = state.hasApiKey ? '已设置；留空保留原密钥' : '填写 API Key（本地免认证服务可留空）';
    keyHint.textContent = state.hasApiKey ? '密钥已自动保存在 VS Code 安全存储中。' : '填写后自动保存到 VS Code 安全存储。';
    removeButton.disabled = !state.hasApiKey && keyRevision === undefined && pending?.keyRevision === undefined;
    setBusy();
}
function validationError(key: ScribeSettingKey, value: ScribeValue): string | undefined {
    const spec = SCRIBE_SETTINGS[key];
    if (!validateSetting(key, value)) {return '请输入有效值。' + spec.description;}
    if (key === 'api.url' && value) {
        try {
            const url = new URL(String(value));
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {throw new Error();}
        } catch {return '请输入完整的 HTTP 或 HTTPS 地址；凭据请填写在密钥输入框中。';}
    }
    return undefined;
}
function save(): void {
    if (!current || pending) {return;}
    const settings: Partial<Record<ScribeSettingKey, ScribeValue>> = {};
    const revisions = new Map<ScribeSettingKey, number>();
    let invalid = false;
    for (const [key, version] of dirty) {
        const input = controls.get(key)!;
        if (current.pinned.includes(key) || composing.has(input)) {continue;}
        const value = input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked
            : SCRIBE_SETTINGS[key].type === 'number' ? (input.value.trim() ? Number(input.value) : NaN) : input.value;
        const error = validationError(key, value);
        input.setAttribute('aria-invalid', String(!!error));
        hints.get(key)!.textContent = error ?? SCRIBE_SETTINGS[key].description;
        if (error) {invalid = true; continue;}
        if (value === current.settings[key]) {dirty.delete(key); continue;}
        settings[key] = value; revisions.set(key, version);
    }
    let secretRevision: number | undefined;
    if (keyRevision !== undefined && !composing.has(keyInput)) {
        if (removeKey || keyInput.value.trim()) {secretRevision = keyRevision;}
        else {keyRevision = undefined;}
    }
    if (queuedAction && (invalid || composing.size)) {
        queuedAction = undefined; setBusy();
        status.textContent = '请先修正标记项并完成输入，再切换或管理配置。';
        if (!revisions.size && secretRevision === undefined) {return;}
    }
    if (!revisions.size && secretRevision === undefined && !queuedAction) {
        status.textContent = invalid ? '标记项尚未保存，请修正输入；其他有效修改已自动保存。'
            : '';
        setBusy();
        return;
    }
    const profileAction = queuedAction; queuedAction = undefined;
    pending = { requestId: ++requestId, revisions, keyRevision: secretRevision, profileAction };
    setBusy();
    status.textContent = '';
    api.postMessage({ type: 'saveSettings', requestId, profileId: current.profileId, settings, ...(profileAction ? {profileAction} : {}),
        ...(secretRevision !== undefined ? (removeKey ? { removeApiKey: true } : { apiKey: keyInput.value }) : {}) });
}
window.addEventListener('message', (event: MessageEvent) => {
    if (!event.origin.startsWith('vscode-webview://')) {return;}
    const message = event.data;
    if (message?.type === 'state') {
        if (!current) {render(); updateState(message.state as ScribeState); return;}
        if (message.saved) {
            if (!pending || message.requestId !== pending.requestId) {return;}
            for (const [key, version] of pending.revisions) {if (dirty.get(key) === version) {dirty.delete(key);}}
            if (pending.keyRevision !== undefined && keyRevision === pending.keyRevision) {
                keyRevision = undefined; keyInput.value = ''; removeKey = false;
            }
            pending = undefined;
            updateState(message.state as ScribeState);
            // 复用节点，保留焦点和等待保存期间产生的新编辑。
            save();
        } else {updateState(message.state as ScribeState);}
    } else if (message?.type === 'saveError' && pending && message.requestId === pending.requestId) {
        pending = undefined; queuedAction = undefined; setBusy();
        if (timer !== undefined) {clearTimeout(timer); timer = undefined;}
        status.textContent = message.text + ' 当前编辑已保留，修改后会重试。';
    }
});
document.addEventListener('visibilitychange', () => {if (document.hidden) {scheduleSave(true);}});
api.postMessage({ type: 'getState' });
