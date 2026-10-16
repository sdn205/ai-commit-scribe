import { SCRIBE_SETTINGS, ScribeSettingKey } from '../scribeSettings';
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Logger } from './logger';
import { toError } from './errorUtils';
import { statOrUndefined } from './fsUtils';
import { isPlainObject, parseAndValidateProjectConfig, ProjectConfig } from './projectConfigParser';

type CacheValue = string | boolean | number;

const CURRENT_DEFAULTS = Object.fromEntries(
    Object.entries(SCRIBE_SETTINGS).map(([key, spec]) => [key, spec.default]),
) as { [K in ScribeSettingKey]: (typeof SCRIBE_SETTINGS)[K]['default'] };

// 旧字段仅用于配置类型校验，不启用已移除的功能。
const PROJECT_CONFIG_SCHEMA = {
    ...CURRENT_DEFAULTS,
    'gemini.model': 'auto',
    'commit.commitLanguage': 'chinese',
    'commit.customLanguageName': '',
    'commit.commitFormat': 'conventional',
    'commit.useCustomInstructions': false,
    'commit.customInstructions': '',
    'commit.refs.enabled': false,
    'commit.refs.source': 'prompt',
    'commit.refs.value': '',
    'commit.refs.placement': 'end',
    'commit.refs.branchPattern': '[A-Z][A-Z0-9]*-[0-9]+',
    'commit.autoCommit': false,
    'commit.autoPush': false,
    'codestral.model': 'codestral-latest',
    'mistral.model': 'mistral-small-latest',
    'provider.type': 'custom',
    'ollama.baseUrl': 'http://localhost:11434',
    'ollama.model': 'llama3.2',
    'ollama.useAuthToken': false,
    'openai.model': 'gpt-3.5-turbo',
    'openai.baseUrl': 'https://api.openai.com/v1',
    'openrouter.model': 'meta-llama/llama-3.3-70b-instruct:free',
    'openrouter.preferFreeModels': false,
    'groq.model': 'llama-3.3-70b-versatile',
    'anthropic.model': 'claude-sonnet-4-5-20250929',
    'deepseek.model': 'deepseek-chat',
    'xai.model': 'grok-3-mini',
    'custom.baseUrl': 'http://localhost:1234/v1',
    'custom.model': '',
    'custom.useApiKey': false,
    'custom.chatCompletionsPath': '/chat/completions',
    'gemini.thinkingBudget': 0,
    'gemini.thinkingLevel': 'low',
    'ollama.numCtx': 0,
    'telemetry.enabled': false,
    'commit.commitlint.enabled': false,
    'commit.commitlint.maxRetries': 3,
    'commit.commitlint.rulesPath': '',
    'commit.commitlint.engine': 'builtin',
} as const;

// 工作区未受信任时，禁止项目配置覆盖请求地址和协议。
const TRUST_SENSITIVE_KEYS: ReadonlySet<string> = new Set<string>([
    'api.url',
    'api.format',
    'openai.baseUrl',
]);

type SettingKey = ScribeSettingKey | 'openai.baseUrl';
type Widened<T> =
  T extends boolean ? boolean :
  T extends number ? number :
  T extends string ? string :
  T;
type SettingValue<K extends SettingKey> = Widened<(typeof PROJECT_CONFIG_SCHEMA)[K]>;

export class ConfigService {
  private static readonly cache = new Map<string, CacheValue>();
  private static projectConfigCache: ProjectConfig | null = null;
  private static projectConfigFileWatcher: vscode.FileSystemWatcher | null =
    null;
  private static disposables: vscode.Disposable[] = [];
  private static readonly projectConfigChangeListeners: Array<() => void> = [];

  static onProjectConfigChange(listener: () => void): vscode.Disposable {
    this.projectConfigChangeListeners.push(listener);
    return {
      dispose: () => {
        const idx = this.projectConfigChangeListeners.indexOf(listener);
        if (idx >= 0) {
          this.projectConfigChangeListeners.splice(idx, 1);
        }
      },
    };
  }

  private static async migrateProjectConfig(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    const legacyPath = path.join(workspaceFolder.uri.fsPath, '.commitscribe');

    try {
      const stats = await statOrUndefined(legacyPath);
      if (stats?.isFile()) {
        const content = await fs.readFile(legacyPath, 'utf8');
        JSON.parse(content);
        await fs.unlink(legacyPath);
        await fs.mkdir(legacyPath, { recursive: true });
        await fs.writeFile(path.join(legacyPath, 'config.json'), content, 'utf8');
        Logger.log('Migrated .commitscribe file to .commitscribe/config.json');
      }
    } catch (error) {
      Logger.error('Failed to migrate .commitscribe config:', toError(error));
    }
  }

  static async initialize(context: vscode.ExtensionContext): Promise<void> {
    await this.migrateProjectConfig();
    await this.loadProjectConfig();

    const configListener = vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (event.affectsConfiguration('commitScribe')) {
          this.clearCache();
          if (event.affectsConfiguration('commitScribe.openai.baseUrl')) {
            const baseUrl = this.get('openai.baseUrl');
            if (baseUrl) {
              try {
                const normalizedEndpoint =
                  this.validateAndNormalizeEndpoint(baseUrl);
                const config = vscode.workspace.getConfiguration('commitScribe');
                void config.update('openai.baseUrl', normalizedEndpoint, true);
              } catch (error: unknown) {
                Logger.error(
                  'Failed to update OpenAI base URL:',
                  toError(error),
                );
              }
            }
          }
        }
      },
    );

    this.initializeProjectConfigWatcher();

    // 授予信任不会重载扩展，需要清除此前按未信任状态解析的缓存。
    const trustListener = vscode.workspace.onDidGrantWorkspaceTrust(() => {
      this.clearCache();
    });

    this.disposables.push(configListener, trustListener);
    context.subscriptions.push(...this.disposables);
  }

  private static initializeProjectConfigWatcher(): void {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    const pattern = new vscode.RelativePattern(workspaceFolder, '{.commitscribe,.commitscribe/config.json}');
    this.projectConfigFileWatcher =
      vscode.workspace.createFileSystemWatcher(pattern);

    const onChange = (): void => this.handleProjectConfigChange();
    this.projectConfigFileWatcher.onDidCreate(onChange);
    this.projectConfigFileWatcher.onDidChange(onChange);
    this.projectConfigFileWatcher.onDidDelete(onChange);

    this.disposables.push(this.projectConfigFileWatcher);
  }

  private static handleProjectConfigChange(): void {
    this.invalidateProjectConfig();
    // 异步重载完成前，同步读取暂时使用工作区、全局或默认配置。
    void this.loadProjectConfig();
    for (const listener of this.projectConfigChangeListeners) {
      try {
        listener();
      } catch (error) {
        Logger.error(
          'Project config change listener threw:',
          toError(error),
        );
      }
    }
  }

  private static invalidateProjectConfig(): void {
    this.projectConfigCache = null;
    this.clearCache();
    Logger.log('Project configuration cache invalidated');
  }

  static getProjectRootPath(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return undefined;
    }
    if (folders.length === 1) {
      return folders[0].uri.fsPath;
    }

    const activeFile = vscode.window.activeTextEditor?.document.uri;
    if (activeFile) {
      const owning = vscode.workspace.getWorkspaceFolder(activeFile);
      if (owning) {
        return owning.uri.fsPath;
      }
    }

    return folders[0].uri.fsPath;
  }

  private static async loadProjectConfig(): Promise<void> {
    const rootPath = this.getProjectRootPath();
    if (!rootPath) {
      this.projectConfigCache = {};
      return;
    }
    const legacyConfigPath = path.join(rootPath, '.commitscribe');
    const dirConfigPath = path.join(rootPath, '.commitscribe', 'config.json');

    try {
      const dirStats = await statOrUndefined(dirConfigPath);
      if (dirStats !== undefined) {
        const configContent = await fs.readFile(dirConfigPath, 'utf8');
        this.projectConfigCache = parseAndValidateProjectConfig(
          configContent,
          '.commitscribe/config.json',
          PROJECT_CONFIG_SCHEMA,
        );
        Logger.log('Loaded project configuration from .commitscribe/config.json');
        return;
      }
      const legacyStats = await statOrUndefined(legacyConfigPath);
      if (legacyStats?.isFile()) {
        const configContent = await fs.readFile(legacyConfigPath, 'utf8');
        this.projectConfigCache = parseAndValidateProjectConfig(
          configContent,
          '.commitscribe',
          PROJECT_CONFIG_SCHEMA,
        );
        Logger.log('Loaded project configuration from .commitscribe file');
        return;
      }
      this.projectConfigCache = {};
    } catch (error) {
      Logger.error('Error reading .commitscribe config:', toError(error));
      this.projectConfigCache = {};
    }
  }

  private static isProjectValueAllowed(configKey: string): boolean {
    if (!TRUST_SENSITIVE_KEYS.has(configKey) || vscode.workspace.isTrusted) {
      return true;
    }
    if (this.getNestedProjectValue(configKey) !== undefined) {
      Logger.warn(
        `Ignoring project config "${configKey}": the workspace is not trusted.`,
      );
    }
    return false;
  }

  private static getNestedProjectValue<T>(key: string): T | undefined {
    let current: unknown = this.projectConfigCache;
    for (const part of key.split('.')) {
      if (!isPlainObject(current) || !(part in current)) {return undefined;}
      current = current[part];
    }
    return current as T;
  }

  static get<K extends SettingKey>(key: K): SettingValue<K> {
    return this.getConfig(key, PROJECT_CONFIG_SCHEMA[key]) as SettingValue<K>;
  }

  static isProjectOverridden(key: string): boolean {
    if (!this.isProjectValueAllowed(key)) {
      return false;
    }
    return this.getNestedProjectValue(key) !== undefined;
  }

  private static getConfig<T extends CacheValue>(configKey: string, defaultValue: T): T {
    try {
      if (!this.cache.has(configKey)) {
        const projectValue = this.isProjectValueAllowed(configKey)
          ? this.getNestedProjectValue<T>(configKey)
          : undefined;

        if (projectValue !== undefined) {
          this.cache.set(configKey, projectValue);
          return projectValue;
        }

        const config = vscode.workspace.getConfiguration('commitScribe');
        const value = config.inspect<T>(configKey);
        // 缓存只按设置键区分，不读取依赖具体文件夹的配置值。

        const effectiveValue =
          value?.workspaceValue ??
          value?.globalValue ??
          value?.defaultValue ??
          defaultValue;

        this.cache.set(configKey, effectiveValue);
      }
      return this.cache.get(configKey) as T;
    } catch (error) {
      Logger.error(`Error getting config ${configKey}:`, toError(error));
      return defaultValue;
    }
  }

  static clearCache(): void {
    this.cache.clear();
  }

  static dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.clearCache();
    this.projectConfigCache = null;
    if (this.projectConfigFileWatcher) {
      this.projectConfigFileWatcher.dispose();
      this.projectConfigFileWatcher = null;
    }
  }

  private static validateAndNormalizeEndpoint(endpoint: string): string {
    if (!endpoint) {
      return '';
    }

    let normalizedEndpoint = endpoint.trim();
    if (
      !normalizedEndpoint.startsWith('http://') &&
      !normalizedEndpoint.startsWith('https://')
    ) {
      normalizedEndpoint = `https://${normalizedEndpoint}`;
    }

    if (normalizedEndpoint.endsWith('/')) {
      normalizedEndpoint = normalizedEndpoint.slice(0, -1);
    }

    return normalizedEndpoint;
  }

}
