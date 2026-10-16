// 优先压缩锁文件和生成文件，再分配其余差异预算，尽量保留各文件信息。

const FILE_TRUNCATED_MARKER = '\n…(file diff truncated)\n';
const DIFF_TRUNCATED_MARKER = '\n…(diff truncated)';

const NOISY_FILE_CAP = 400;

const NOISY_BASENAMES = new Set([
    'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
    'bun.lockb', 'bun.lock', 'deno.lock',
    'composer.lock', 'gemfile.lock', 'cargo.lock', 'go.sum', 'flake.lock', 'mix.lock',
    'poetry.lock', 'pipfile.lock', 'pdm.lock', 'uv.lock', 'conda-lock.yml',
    'pubspec.lock', 'podfile.lock', 'package.resolved', 'packages.lock.json',
    'gradle.lockfile', 'cabal.project.freeze', 'paket.lock',
    'chart.lock', 'renv.lock', 'shard.lock', 'vcpkg-lock.json', 'conan.lock',
    '.terraform.lock.hcl',
]);
const NOISY_PATH =
    /(?:\.min\.(?:js|css|mjs|cjs)|\.map|\.snap|\.lock|\.lockfile|-lock\.json|\.pb\.(?:go|cc|h)|_pb2(?:_grpc)?\.py|\.g\.(?:dart|cs)|\.freezed\.dart|\.designer\.cs|\.generated\.[a-z]+)$/i;
const NOISY_DIR =
    /(?:^|\/)(?:dist|build|out|target|vendor|node_modules|bower_components|__snapshots__|__pycache__|coverage|obj|gen|generated|\.next|\.nuxt|\.svelte-kit|\.terraform)\//;

export function blockPath(block: string): string {
    const unquoted = /(?:^|\n)diff --git a\/(.+?) b\//.exec(block);
    if (unquoted) {
        return unquoted[1];
    }
    const quoted = /(?:^|\n)diff --git "a\/(.+?)" "b\//.exec(block);
    return quoted ? quoted[1] : '';
}

export function isNoisyPath(path: string): boolean {
    if (!path) {
        return false;
    }
    const basename = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    return NOISY_BASENAMES.has(basename) || NOISY_PATH.test(path) || NOISY_DIR.test(path);
}

function sliceAtLineBoundary(s: string, limit: number): string {
    if (s.length <= limit) {
        return s;
    }
    const lastNewline = s.lastIndexOf('\n', limit);
    return s.slice(0, lastNewline > 0 ? lastNewline : limit);
}

export function splitIntoFileBlocks(diff: string): string[] {
    const marker = 'diff --git ';
    const starts: number[] = [];
    if (diff.startsWith(marker)) {
        starts.push(0);
    }
    for (let idx = diff.indexOf('\n' + marker); idx !== -1; idx = diff.indexOf('\n' + marker, idx + 1)) {
        starts.push(idx + 1);
    }
    if (starts.length === 0) {
        return [diff];
    }
    const blocks: string[] = [];
    for (let i = 0; i < starts.length; i++) {
        const end = i + 1 < starts.length ? starts[i + 1] : diff.length;
        blocks.push(diff.slice(starts[i], end));
    }
    if (starts[0] > 0) {
        blocks[0] = diff.slice(0, starts[0]) + blocks[0];
    }
    return blocks;
}

function fairBudgets(lengths: number[], budget: number): number[] {
    const n = lengths.length;
    if (n === 0) {
        return [];
    }
    const equalShare = Math.floor(budget / n);
    const smallTotal = lengths.filter(l => l <= equalShare).reduce((sum, l) => sum + l, 0);
    const largeCount = lengths.filter(l => l > equalShare).length;
    const largeShare = largeCount > 0
        ? Math.max(0, Math.floor((budget - smallTotal) / largeCount))
        : 0;
    return lengths.map(l => (l <= equalShare ? l : largeShare));
}

function allocateBudgets(blocks: string[], maxLength: number): number[] {
    const lengths = blocks.map(b => b.length);
    const noisy = blocks.map(b => isNoisyPath(blockPath(b)));

    const capped = lengths.map((len, i) => (noisy[i] ? Math.min(len, NOISY_FILE_CAP) : len));
    if (capped.reduce((a, b) => a + b, 0) <= maxLength) {
        return capped;
    }

    const noisyAlloc = lengths.map((len, i) => (noisy[i] ? Math.min(len, NOISY_FILE_CAP) : 0));
    const noisyTotal = noisyAlloc.reduce((a, b) => a + b, 0);
    if (noisyTotal < maxLength) {
        const meaningfulIdx = blocks.map((_, i) => i).filter(i => !noisy[i]);
        const meaningfulBudgets = fairBudgets(meaningfulIdx.map(i => lengths[i]), maxLength - noisyTotal);
        const target = [...noisyAlloc];
        meaningfulIdx.forEach((blockIdx, k) => { target[blockIdx] = meaningfulBudgets[k]; });
        return target;
    }

    return fairBudgets(lengths, maxLength);
}

function renderBlock(block: string, budget: number): string {
    if (block.length <= budget) {
        return block;
    }
    return sliceAtLineBoundary(block, Math.max(0, budget - FILE_TRUNCATED_MARKER.length)) + FILE_TRUNCATED_MARKER;
}

export function truncateDiff(diff: string, maxLength: number): string {
    if (diff.length <= maxLength) {
        return diff;
    }

    const blocks = splitIntoFileBlocks(diff);

    if (blocks.length <= 1) {
        return sliceAtLineBoundary(diff, maxLength) + DIFF_TRUNCATED_MARKER;
    }

    const budgets = allocateBudgets(blocks, maxLength);
    return blocks.map((block, i) => renderBlock(block, budgets[i])).join('');
}
