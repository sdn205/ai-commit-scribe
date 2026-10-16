import * as crypto from 'node:crypto';

export function getNonce(): string {
    return crypto.randomBytes(24).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
}
