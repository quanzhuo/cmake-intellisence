import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceCMakeFilePolicy } from '../../workspaceScanner';

suite('workspace scanner', () => {
    let rootPath: string;

    setup(async () => {
        rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cmake-workspace-scanner-'));
    });

    teardown(async () => {
        await fs.promises.rm(rootPath, { recursive: true, force: true });
    });

    async function write(relativePath: string): Promise<string> {
        const filePath = path.join(rootPath, relativePath);
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, '');
        return filePath;
    }

    function createPolicy(ignoredDirectoryNames: string[] = [], excludeCMakeBuildDirectories = true, excludedDirectoryPaths: string[] = []): WorkspaceCMakeFilePolicy {
        return new WorkspaceCMakeFilePolicy(rootPath, {
            ignoredDirectoryNames,
            excludeCMakeBuildDirectories,
            excludedDirectoryPaths,
        });
    }

    test('collects CMake files from source directories', async () => {
        const rootList = await write('CMakeLists.txt');
        const helper = await write(path.join('cmake', 'helpers.cmake'));
        await write(path.join('src', 'main.cpp'));

        const result = await createPolicy().collectFiles();

        assert.deepStrictEqual(result.sort(), [rootList, helper].sort());
    });

    test('skips an entire directory containing CMakeCache.txt', async () => {
        const rootList = await write('CMakeLists.txt');
        await write(path.join('custom-output', 'CMakeCache.txt'));
        await fs.promises.mkdir(path.join(rootPath, 'custom-output', 'CMakeFiles'));
        await write(path.join('custom-output', 'generated.cmake'));
        await write(path.join('custom-output', 'nested', 'CMakeLists.txt'));

        const result = await createPolicy().collectFiles();

        assert.deepStrictEqual(result, [rootList]);
    });

    test('skips the workspace root when it contains CMakeCache.txt', async () => {
        await write('CMakeCache.txt');
        await fs.promises.mkdir(path.join(rootPath, 'CMakeFiles'));
        await write('CMakeLists.txt');
        await write(path.join('nested', 'helpers.cmake'));

        const result = await createPolicy().collectFiles();

        assert.deepStrictEqual(result, []);
    });

    test('does not skip a directory with only CMakeCache.txt', async () => {
        await write('CMakeCache.txt');
        const rootList = await write('CMakeLists.txt');

        const result = await createPolicy().collectFiles();

        assert.deepStrictEqual(result, [rootList]);
    });

    test('can scan detected build directories when exclusion is disabled', async () => {
        await write('CMakeCache.txt');
        await fs.promises.mkdir(path.join(rootPath, 'CMakeFiles'));
        const rootList = await write('CMakeLists.txt');
        const generated = await write(path.join('nested', 'generated.cmake'));

        const result = await createPolicy([], false).collectFiles();

        assert.deepStrictEqual(result.sort(), [rootList, generated].sort());
    });

    test('still applies configured ignored directory names', async () => {
        const rootList = await write('CMakeLists.txt');
        await write(path.join('vendor', 'dependency.cmake'));

        const result = await createPolicy(['vendor']).collectFiles();

        assert.deepStrictEqual(result, [rootList]);
    });

    test('uses the same policy for collection and watched-file acceptance', async () => {
        const sourceFile = await write(path.join('cmake', 'source.cmake'));
        const ignoredFile = await write(path.join('vendor', 'ignored.cmake'));
        const buildDirectory = path.join(rootPath, 'custom-build');
        const generatedFile = await write(path.join('custom-build', 'generated.cmake'));
        const policy = createPolicy(['vendor'], true, [buildDirectory]);

        assert.strictEqual(await policy.accepts(sourceFile), true);
        assert.strictEqual(await policy.accepts(ignoredFile), false);
        assert.strictEqual(await policy.accepts(generatedFile), false);
        assert.deepStrictEqual(await policy.collectFiles(), [sourceFile]);
    });
});
