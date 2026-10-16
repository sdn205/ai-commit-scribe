export interface BlameInfo {
    author: string;
    email: string;
    date: string;
    timestamp: number;
    lineNumber: number;
}

export function parseBlameOutput(blameOutput: string): BlameInfo[] {
    const lines = blameOutput.split('\n');
    const blameInfos: BlameInfo[] = [];
    let currentBlame: Partial<BlameInfo> = {};

    for (const line of lines) {
        if (line.startsWith('author ')) {
            currentBlame.author = line.substring(7);
        } else if (line.startsWith('author-mail ')) {
            currentBlame.email = line.substring(12).replace(/[<>]/g, '');
        } else if (line.startsWith('author-time ')) {
            const ts = Number.parseInt(line.substring(12), 10);
            if (Number.isFinite(ts)) {
                currentBlame.timestamp = ts;
                currentBlame.date = new Date(ts * 1000).toISOString();
            }
        } else if (line.startsWith('\t')) {
            // 空白源代码行也计数；时间戳 0 是有效值，不能按真假判断。
            if (
                currentBlame.author !== undefined &&
                currentBlame.email !== undefined &&
                currentBlame.date !== undefined &&
                currentBlame.timestamp !== undefined &&
                currentBlame.lineNumber !== undefined
            ) {
                blameInfos.push(currentBlame as BlameInfo);
            }
            currentBlame = {};
        } else {
            const match = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(line);
            if (match) {
                currentBlame.lineNumber = Number.parseInt(match[2], 10);
            }
        }
    }

    return blameInfos;
}

export function parseChangedLines(diff: string): Set<number> {
    const changedLines = new Set<number>();
    const lines = diff.split('\n');
    let currentLine = 0;

    for (const line of lines) {
        const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (match) {
            currentLine = Number.parseInt(match[1], 10);
        } else if (line.startsWith('\\ ')) {
            // 缺少末尾换行的标记不占源代码行号。
            continue;
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
            changedLines.add(currentLine);
            currentLine++;
        } else if (!line.startsWith('-') && !line.startsWith('---')) {
            currentLine++;
        }
    }

    return changedLines;
}

export function analyzeBlameInfo(
    blame: BlameInfo[],
    changedLines: Set<number>
): Map<string, { count: number; lines: number[] }> {
    const authorChanges = new Map<string, { count: number; lines: number[] }>();

    for (const info of blame) {
        if (changedLines.has(info.lineNumber)) {
            const key = `${info.author} <${info.email}>`;
            const current = authorChanges.get(key) || { count: 0, lines: [] };
            current.count++;
            current.lines.push(info.lineNumber);
            authorChanges.set(key, current);
        }
    }

    return authorChanges;
}

export function formatAnalysis(
    authorChanges: Map<string, { count: number; lines: number[] }>
): string {
    if (authorChanges.size === 0) {
        return 'No changes detected.';
    }

    const sortedAuthors = Array.from(authorChanges.entries()).sort(
        (a, b) => b[1].count - a[1].count
    );

    return sortedAuthors
        .map(
            ([author, { count, lines }]) =>
                `${author} modified ${count} line${count === 1 ? '' : 's'} (${lines.join(', ')})`
        )
        .join('\n');
}
