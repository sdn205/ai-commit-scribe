import { Logger } from './logger';
export type ProjectConfig = Record<string, Record<string, unknown>>;


const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
    );
}

// 校验已知字段的类型；保留未知字段，以兼容新版配置。
export function parseAndValidateProjectConfig(
    raw: string,
    source: string,
    schema: Record<string, unknown>,
): ProjectConfig {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) {
        Logger.warn(`Project config at ${source} is not an object — ignoring.`);
        return {};
    }
    const validated: Record<string, Record<string, unknown>> = {};
    for (const [section, value] of Object.entries(parsed)) {
        // 拒绝可能修改返回对象原型的特殊分区名。
        if (UNSAFE_KEYS.has(section)) {
            Logger.warn(`Project config at ${source}: ignoring reserved section "${section}".`);
            continue;
        }
        if (!isPlainObject(value)) {
            Logger.warn(
                `Project config at ${source}: section "${section}" is not an object, skipping.`,
            );
            continue;
        }
        const validatedSection: Record<string, unknown> = {};
        for (const [leaf, leafValue] of Object.entries(value)) {
            const fullKey = `${section}.${leaf}`;
            const expected = schema[fullKey];
            if (expected === undefined || typeof leafValue === typeof expected) {
                validatedSection[leaf] = leafValue;
            } else {
                Logger.warn(
                    `Project config at ${source}: "${fullKey}" expected ${typeof expected}, got ${typeof leafValue} — skipping.`,
                );
            }
        }
        validated[section] = validatedSection;
    }
    return validated;
}
