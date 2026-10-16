import * as vscode from 'vscode';
import { redactApiSecrets } from './errorUtils';

export class Logger {
    private static channel: vscode.LogOutputChannel | null = null;

    private static readonly secrets = new Set<string>();

    static registerSecret(value: string | undefined): void {
        // 过短的值容易误匹配普通日志内容，不登记为脱敏词。
        if (value && value.length >= 8) {
            this.secrets.add(value);
        }
    }

    private static redact(text: string): string {
        let result = redactApiSecrets(text);
        for (const secret of this.secrets) {
            result = result.replaceAll(secret, '<redacted>');
        }
        return result;
    }

    private static redactError(error: Error): Error {
        const copy = new Error(this.redact(error.message));
        copy.name = error.name;
        copy.stack = error.stack ? this.redact(error.stack) : undefined;
        return copy;
    }

    static initialize(): void {
        this.channel = vscode.window.createOutputChannel('CommitScribe', { log: true });
        this.channel.info('Logger initialized');
    }

    static log(message: string): void {
        this.channel?.info(this.redact(message));
    }

    static warn(message: string): void {
        this.channel?.warn(this.redact(message));
    }

    static error(message: string, error?: Error): void {
        if (!this.channel) { return; }
        if (error) {
            this.channel.error(this.redact(message), this.redactError(error));
        } else {
            this.channel.error(this.redact(message));
        }
    }

    static async showError(message: string, ...actions: string[]): Promise<string | undefined> {
        return await vscode.window.showErrorMessage(`CommitScribe: ${this.redact(message)}`, ...actions);
    }

    static dispose(): void {
        this.channel?.dispose();
        this.channel = null;
        this.secrets.clear();
    }
}
