import * as fs from 'node:fs/promises';

export async function statOrUndefined(p: string): Promise<import('node:fs').Stats | undefined> {
    try {
        return await fs.stat(p);
    } catch {
        return undefined;
    }
}
