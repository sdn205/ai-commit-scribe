import * as vscode from 'vscode';
import { ConfigService } from './utils/configService';
import { Logger } from './utils/logger';
import { CommitWorkflow } from './services/commitWorkflow';
import { ScribeSecrets } from './services/scribeSecrets';
import { ScribeProfiles } from './services/scribeProfiles';
import { ScribeSettingsProvider } from './views/scribeSettingsProvider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    Logger.initialize();
    CommitWorkflow.syncGenerationContext();
    ScribeSecrets.initialize(context.secrets);
    await ConfigService.initialize(context);
    ScribeProfiles.initialize(context);
    context.subscriptions.push(
        vscode.commands.registerCommand('commitscribe.cancelGeneration', () => CommitWorkflow.cancelGeneration()),
        vscode.window.registerWebviewViewProvider(ScribeSettingsProvider.viewId, new ScribeSettingsProvider(context)),
        vscode.commands.registerCommand('commitscribe.generateCommitMessage', async (source?: vscode.SourceControl) => {
            await CommitWorkflow.generateAndSetCommitMessage(source);
        }),
        vscode.commands.registerCommand('commitscribe.openSettings', () => vscode.commands.executeCommand('commitscribe.settings.focus')),
    );
    Logger.log('AICommitScribe 已启动');
}
export async function deactivate(): Promise<void> {
    CommitWorkflow.cancelGeneration();
    ConfigService.dispose();
    Logger.dispose();
}
