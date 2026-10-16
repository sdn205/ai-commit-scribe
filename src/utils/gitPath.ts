const C_ESCAPES: Record<string, string> = {
    a: '\u0007',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
};

// Git 用八进制字节转义中文等路径字符，需要按 UTF-8 还原。
export function unquoteGitPath(filePath: string): string {
    if (!filePath.startsWith('"') || !filePath.endsWith('"')) {
        return filePath;
    }
    let unquoted = filePath.slice(1, -1);

    unquoted = unquoted.replaceAll(/\\([0-7]{3})/g, (_, octal) => {
        return String.fromCodePoint(Number.parseInt(octal, 8));
    });

    try {
        const bytes = new Uint8Array([...unquoted].map((c) => c.codePointAt(0) ?? 0));
        unquoted = new TextDecoder('utf-8').decode(bytes);
    } catch {
    }

    // 只反转义一次，避免把路径中的字面量反斜杠再次解释为转义符。
    unquoted = unquoted.replaceAll(
        /\\(.)/g,
        (_, ch: string) => C_ESCAPES[ch] ?? ch,
    );
    return unquoted;
}
