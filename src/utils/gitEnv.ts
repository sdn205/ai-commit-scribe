// 仅传递必要环境变量，避免泄漏无关密钥或被外部 GIT_* 改变命令行为。
const GIT_ENV_WHITELIST = [
    'PATH',
    'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA',
    'TEMP', 'TMP', 'TMPDIR',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
    'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
    'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH',
    'GIT_SSH', 'GIT_SSH_COMMAND',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
] as const;

export function buildGitEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const k of GIT_ENV_WHITELIST) {
        const v = process.env[k];
        if (v !== undefined) {
            env[k] = v;
        }
    }
    env.GIT_TERMINAL_PROMPT = '0';
    return env;
}
