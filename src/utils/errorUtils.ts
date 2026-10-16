export function toError(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    }
    return new Error(String(error));
}

const URL_KEY_PATTERN = /([?&])key=[^&\s'"]+/gi;
const BEARER_PATTERN = /Bearer\s+[A-Z0-9._-]+/gi;
const GOOGLE_API_KEY_HEADER = /x-goog-api-key:\s*[^\s'",]+/gi;
// 连同认证方案一起匹配，避免只遮盖 Bearer 而漏出后面的密钥。
const AUTHORIZATION_HEADER = /Authorization:\s*(?:[A-Za-z]+\s+)?[^\s'",]+/gi;

export function redactApiSecrets(text: string): string {
    return text
        .replace(URL_KEY_PATTERN, '$1key=<redacted>')
        .replace(BEARER_PATTERN, 'Bearer <redacted>')
        .replace(GOOGLE_API_KEY_HEADER, 'x-goog-api-key: <redacted>')
        .replace(AUTHORIZATION_HEADER, 'Authorization: <redacted>');
}
