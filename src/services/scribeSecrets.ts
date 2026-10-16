import * as vscode from 'vscode';
import { Logger } from '../utils/logger';

export class ScribeSecrets {
    static readonly key = 'commitScribe.apiKey';
    private static secrets: vscode.SecretStorage;
    static initialize(secrets: vscode.SecretStorage): void { this.secrets = secrets; }
    private static storageKey(profileId: string): string {return profileId === 'default' ? this.key : this.key + '.' + profileId;}
    static isKey(key: string): boolean {return key === this.key || key.startsWith(this.key + '.');}
    static async get(profileId = 'default'): Promise<string | undefined> {
        const value = await this.secrets.get(this.storageKey(profileId));
        Logger.registerSecret(value);
        return value;
    }
    static async set(value: string, profileId = 'default'): Promise<void> {
        const trimmed = value.trim();
        if (!trimmed || /[\r\n]/.test(trimmed)) {throw new Error('API Key 不能为空或包含换行。');}
        Logger.registerSecret(trimmed);
        await this.secrets.store(this.storageKey(profileId), trimmed);
    }
    static async remove(profileId = 'default'): Promise<void> { await this.secrets.delete(this.storageKey(profileId)); }
}
