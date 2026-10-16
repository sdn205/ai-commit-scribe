const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const analyze = process.argv.includes('--analyze');

// 输出格式须匹配 VS Code 的问题匹配器，才能显示构建错误。
const esbuildProblemMatcherPlugin = {
    name: 'esbuild-problem-matcher',
    setup(build) {
        build.onStart(() => {
            console.log('[watch] build started');
        });
        build.onEnd((result) => {
            result.errors.forEach(({ text, location }) => {
                console.error(`✘ [ERROR] ${text}`);
                if (location == null) return;
                console.error(`    ${location.file}:${location.line}:${location.column}:`);
            });
            console.log('[watch] build finished');
        });
    },
};

const extensionBuildOptions = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    sourcemap: !production,
    sourcesContent: false,
    minify: production,
    logLevel: 'info',
    metafile: analyze,
    plugins: [esbuildProblemMatcherPlugin],
};

const webviewBuildOptions = {
    entryPoints: ['src/views/webview/scribeMain.ts'],
    bundle: true,
    outfile: 'dist/webview/main.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    sourcemap: !production,
    sourcesContent: false,
    minify: production,
    logLevel: 'info',
    plugins: [esbuildProblemMatcherPlugin],
};

const stylesBuildOptions = {
    entryPoints: ['src/views/webview/styles.css'],
    bundle: true,
    outfile: 'dist/webview/styles.css',
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
    plugins: [esbuildProblemMatcherPlugin],
};

async function main() {
    if (watch) {
        const [extCtx, webCtx, cssCtx] = await Promise.all([
            esbuild.context(extensionBuildOptions),
            esbuild.context(webviewBuildOptions),
            esbuild.context(stylesBuildOptions),
        ]);
        await Promise.all([extCtx.watch(), webCtx.watch(), cssCtx.watch()]);
        console.log('[esbuild] watching for changes…');
        return;
    }

    // 生产构建清除开发构建遗留的映射文件，避免被打进安装包。
    if (production) {
        for (const stale of [
            path.join('dist', 'extension.js.map'),
            path.join('dist', 'webview', 'main.js.map'),
            path.join('dist', 'webview', 'styles.css.map'),
        ]) {
            if (fs.existsSync(stale)) {
                fs.unlinkSync(stale);
            }
        }
    }

    const [extResult] = await Promise.all([
        esbuild.build(extensionBuildOptions),
        esbuild.build(webviewBuildOptions),
        esbuild.build(stylesBuildOptions),
    ]);

    if (analyze && extResult.metafile) {
        const metaPath = path.join('dist', 'meta.json');
        fs.writeFileSync(metaPath, JSON.stringify(extResult.metafile));
        console.log(`[esbuild] metafile written to ${metaPath}`);
        console.log('[esbuild] analyze at https://esbuild.github.io/analyze/');
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
