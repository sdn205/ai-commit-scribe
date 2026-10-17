import * as vscode from 'vscode';
import { ConfigService } from '../utils/configService';
import { ScribeSecrets } from '../services/scribeSecrets';
import { ScribeProfiles } from '../services/scribeProfiles';
import { SCRIBE_SETTINGS, ScribeSettingKey, ScribeValue, ScribeState, validateSetting } from '../scribeSettings';
import { getNonce } from '../utils/nonce';
import { resolveEndpoint } from '../services/scribeApi';
import { Logger } from '../utils/logger';

export class ScribeSettingsProvider implements vscode.WebviewViewProvider {
    static readonly viewId = 'commitscribe.settings';
    private view?: vscode.WebviewView;
    private saving = false;
    private saveQueue: Promise<void> = Promise.resolve();
    constructor(private readonly context: vscode.ExtensionContext) {}
    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        const assets = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
        view.webview.options = { enableScripts: true, localResourceRoots: [assets] };
        const script = view.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'main.js'));
        const style = view.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'styles.css'));
        const nonce = getNonce();
        view.webview.html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">' +
            '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
            '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + view.webview.cspSource +
            '; script-src \'nonce-' + nonce + '\';"><link rel="stylesheet" href="' + style + '">' +
            '<title>AICommitScribe 管理面板</title></head><body><div id="root">正在加载…</div>' +
            '<script nonce="' + nonce + '" src="' + script + '"></script></body></html>';
        const subscriptions = [
            view.webview.onDidReceiveMessage((message: unknown) => {
                this.saveQueue = this.saveQueue.then(() => this.handle(message)).catch(error => {
                    Logger.error('自动保存队列异常', error instanceof Error ? error : undefined);
                });
            }),
            vscode.workspace.onDidChangeConfiguration(e => {
                if (!this.saving && e.affectsConfiguration('commitScribe')) {void this.pushState();}
            }),
            ConfigService.onProjectConfigChange(() => { if (!this.saving) {void this.pushState();} }),
            this.context.secrets.onDidChange(e => {
                if (!this.saving && ScribeSecrets.isKey(e.key)) {void this.pushState();}
            }),
        ];
        view.onDidDispose(() => { subscriptions.forEach(s => s.dispose()); this.view = undefined; });
    }
    private async handle(message: unknown): Promise<void> {
        let requestId: number | undefined;
        try {
            if (!message || typeof message !== 'object') {return;}
            const msg = message as { type?: string; requestId?: number; profileId?: string; settings?: Record<string, unknown>; apiKey?: unknown; removeApiKey?: unknown; profileAction?: {type?: string; id?: string} };
            if (msg.type === 'getState') { await this.pushState(); return; }
            if (msg.type !== 'saveSettings' || !msg.settings || typeof msg.settings !== 'object' || Array.isArray(msg.settings)) {return;}
            if (!Number.isSafeInteger(msg.requestId) || msg.requestId! < 1) {return;}
            requestId = msg.requestId;
            if (typeof msg.profileId !== 'string') {throw new Error('缺少 API 配置标识，请重新打开管理面板。');}
            const profile = ScribeProfiles.get(msg.profileId);
            const action = msg.profileAction;
            if (action && (!['create', 'rename', 'delete', 'switch'].includes(action.type ?? '') || (action.type === 'switch' && typeof action.id !== 'string'))) {throw new Error('配置操作无效。');}
            for (const [key, value] of Object.entries(msg.settings)) {
                if (!validateSetting(key, value)) {throw new Error('设置值无效：' + key);}
                if ((!key.startsWith('api.') || profile.id === ScribeProfiles.defaultId) && ConfigService.isProjectOverridden(key)) {throw new Error('此项由 .commitscribe/config.json 固定，请在该文件中修改：' + key);}
                if (key === 'api.url' && value) {resolveEndpoint(value as string, 'responses');}
            }
            if (msg.apiKey !== undefined && (typeof msg.apiKey !== 'string' || /[\r\n]/.test(msg.apiKey))) {
                throw new Error('API Key 格式无效。');
            }
            if (msg.removeApiKey !== undefined && typeof msg.removeApiKey !== 'boolean') {throw new Error('密钥操作无效。');}
            if (msg.removeApiKey && msg.apiKey !== undefined) {throw new Error('无法同时保存和移除密钥。');}
            this.saving = true;
            try {
                await ScribeProfiles.save(profile.id, msg.settings as Partial<Record<ScribeSettingKey, ScribeValue>>);
                const config = vscode.workspace.getConfiguration('commitScribe');
                for (const [key, value] of Object.entries(msg.settings)) {
                    if (key.startsWith('api.')) {continue;}
                    const inspected = config.inspect(key);
                    const target = inspected?.workspaceValue !== undefined
                        ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
                    await config.update(key, value, target);
                }
                if (typeof msg.apiKey === 'string' && msg.apiKey.trim()) {await ScribeSecrets.set(msg.apiKey, profile.id);}
                if (msg.removeApiKey) {await ScribeSecrets.remove(profile.id);}
                ConfigService.clearCache();
                if (action?.type === 'switch') {await ScribeProfiles.select(action.id!);}
                else if (action?.type === 'create' || action?.type === 'rename') {
                    const rename = action.type === 'rename';
                    const name = await vscode.window.showInputBox({ title: rename ? '重命名 API 配置' : '新增 API 配置',
                        prompt: '每套配置分别保存 URL、Key、模型 ID 和请求格式',
                        value: rename ? profile.name : '', ignoreFocusOut: true,
                        validateInput: value => ScribeProfiles.nameError(value, rename ? profile.id : undefined) });
                    if (name !== undefined) {
                        if (rename) {await ScribeProfiles.rename(profile.id, name);}
                        else {await ScribeProfiles.create(name);}
                    }
                } else if (action?.type === 'delete') {
                    if (profile.id === ScribeProfiles.defaultId) {throw new Error('默认配置不能删除。');}
                    const answer = await vscode.window.showWarningMessage('删除 API 配置“' + profile.name + '”及其密钥？', { modal: true }, '删除');
                    if (answer === '删除') {await ScribeProfiles.remove(profile.id);}
                }
            } finally { this.saving = false; }
            await this.pushState(true, requestId);
        } catch (error) {
            this.saving = false;
            Logger.error('保存设置失败', error instanceof Error ? error : undefined);
            await this.view?.webview.postMessage({ type: 'saveError', requestId, text: error instanceof Error ? error.message : '自动保存失败，请重试。' });
        }
    }
    private async pushState(saved = false, requestId?: number): Promise<void> {
        const profile = ScribeProfiles.active();
        const settings = Object.fromEntries(Object.keys(SCRIBE_SETTINGS).map(key =>
            [key, ConfigService.get(key as ScribeSettingKey)])) as Record<ScribeSettingKey, ScribeValue>;
        settings['api.url'] = profile.url; settings['api.model'] = profile.model; settings['api.format'] = profile.format;
        settings['api.reasoningEffort'] = profile.reasoningEffort ?? '';
        const state: ScribeState = { settings,
            pinned: Object.keys(SCRIBE_SETTINGS).filter(key => (!key.startsWith('api.') || profile.id === ScribeProfiles.defaultId) && ConfigService.isProjectOverridden(key)),
            profileId: profile.id, profiles: ScribeProfiles.list().map(p => ({ id: p.id, name: p.name })),
            hasApiKey: !!(await ScribeSecrets.get(profile.id)) };
        await this.view?.webview.postMessage({ type: 'state', state, saved, requestId });
    }
}
