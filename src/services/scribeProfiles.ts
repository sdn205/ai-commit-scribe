import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { ScribeProfile, ScribeSettingKey, ScribeValue } from '../scribeSettings';
import { ConfigService } from '../utils/configService';
import { ScribeSecrets } from './scribeSecrets';

interface ProfileStore { defaultName: string; profiles: ScribeProfile[] }
export class ScribeProfiles {
    static readonly defaultId = 'default';
    private static readonly storeKey = 'commitScribe.apiProfiles';
    private static readonly activeKey = 'commitScribe.activeApiProfile';
    private static context: vscode.ExtensionContext;
    static initialize(context: vscode.ExtensionContext): void { this.context = context; }
    private static store(): ProfileStore {
        return this.context.globalState.get<ProfileStore>(this.storeKey) ?? { defaultName: '默认配置', profiles: [] };
    }
    static list(): ScribeProfile[] {
        const stored = this.store();
        return [{ id: this.defaultId, name: stored.defaultName, url: ConfigService.get('api.url'),
            model: ConfigService.get('api.model'), reasoningEffort: ConfigService.get('api.reasoningEffort'),
            format: ConfigService.get('api.format') as ScribeProfile['format'] }, ...stored.profiles];
    }
    static active(): ScribeProfile {
        const profiles = this.list();
        return profiles.find(p => p.id === this.context.workspaceState.get<string>(this.activeKey)) ?? profiles[0];
    }
    static get(id: string): ScribeProfile {
        const profile = this.list().find(p => p.id === id);
        if (!profile) {throw new Error('此配置已不存在，请重新打开管理面板。');}
        return profile;
    }
    static async select(id: string): Promise<void> { this.get(id); await this.context.workspaceState.update(this.activeKey, id); }
    private static validateName(name: string, exceptId?: string): string {
        const trimmed = name.trim();
        if (!trimmed || trimmed.length > 80) {throw new Error('配置名称需为 1 至 80 个字符。');}
        if (this.list().some(p => p.id !== exceptId && p.name === trimmed)) {throw new Error('已有同名配置，请使用其他名称。');}
        return trimmed;
    }
    static nameError(name: string, exceptId?: string): string | undefined {
        try {this.validateName(name, exceptId); return undefined;} catch (error) {return (error as Error).message;}
    }
    static async create(name: string): Promise<void> {
        const profile: ScribeProfile = { id: randomUUID(), name: this.validateName(name), url: '', model: '', format: 'responses' };
        const stored = this.store();
        await this.context.globalState.update(this.storeKey, { ...stored, profiles: [...stored.profiles, profile] });
        await this.select(profile.id);
    }
    static async rename(id: string, name: string): Promise<void> {
        this.get(id);
        const nextName = this.validateName(name, id);
        const stored = this.store();
        await this.context.globalState.update(this.storeKey, { defaultName: id === this.defaultId ? nextName : stored.defaultName,
            profiles: stored.profiles.map(p => p.id === id ? { ...p, name: nextName } : p) });
    }
    static async remove(id: string): Promise<void> {
        if (id === this.defaultId) {throw new Error('默认配置保留原有接口设置，不能删除。');}
        this.get(id);
        const stored = this.store();
        await this.context.globalState.update(this.storeKey, { ...stored, profiles: stored.profiles.filter(p => p.id !== id) });
        await this.select(this.defaultId);
        await ScribeSecrets.remove(id);
    }
    static async save(id: string, settings: Partial<Record<ScribeSettingKey, ScribeValue>>): Promise<void> {
        const profile = this.get(id);
        const connection = Object.entries(settings).filter(([key]) => key.startsWith('api.'));
        if (!connection.length) {return;}
        if (id === this.defaultId) {
            const config = vscode.workspace.getConfiguration('commitScribe');
            for (const [key, value] of connection) {
                const target = config.inspect(key)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
                await config.update(key, value, target);
            }
            ConfigService.clearCache();
        } else {
            const updated = { ...profile };
            if (typeof settings['api.url'] === 'string') {updated.url = settings['api.url'];}
            if (typeof settings['api.model'] === 'string') {updated.model = settings['api.model'];}
            if (typeof settings['api.reasoningEffort'] === 'string') {updated.reasoningEffort = settings['api.reasoningEffort'];}
            if (settings['api.format'] === 'responses' || settings['api.format'] === 'chat') {updated.format = settings['api.format'];}
            const stored = this.store();
            await this.context.globalState.update(this.storeKey, { ...stored, profiles: stored.profiles.map(p => p.id === id ? updated : p) });
        }
    }
}
