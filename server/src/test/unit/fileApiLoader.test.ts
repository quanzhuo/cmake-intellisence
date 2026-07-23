import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { findLatestFileApiIndexFile, getFileApiReplyDirectory, loadFileApiRawSnapshot } from '../../fileApiLoader';

function normalizeDirectoryMapKeyForTest(filePath: string): string {
    const normalized = path.normalize(filePath);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

suite('File API Loader Tests', () => {
    test('should load the latest reply index and referenced objects', async () => {
        const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-file-api-'));
        const replyDir = getFileApiReplyDirectory(buildDir);
        fs.mkdirSync(replyDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(replyDir, 'index-aaa.json'), JSON.stringify({ objects: [] }), 'utf8');

            fs.writeFileSync(path.join(replyDir, 'cache-v2.json'), JSON.stringify({
                entries: [
                    {
                        name: 'CMAKE_BUILD_TYPE',
                        value: 'Debug',
                        type: 'STRING',
                        properties: [{ name: 'HELPSTRING', value: 'Build type' }],
                    },
                    {
                        name: 'CMAKE_HOME_DIRECTORY',
                        value: buildDir,
                        type: 'INTERNAL',
                    },
                ],
            }), 'utf8');

            fs.writeFileSync(path.join(replyDir, 'cmakeFiles-v1.json'), JSON.stringify({
                inputs: [
                    { path: 'CMakeLists.txt' },
                    { path: '/external/toolchain.cmake', isExternal: true },
                ],
                globsDependent: [
                    { paths: ['src/a.cpp', 'src/b.cpp'] },
                ],
            }), 'utf8');

            fs.writeFileSync(path.join(replyDir, 'toolchains-v1.json'), JSON.stringify({
                toolchains: [
                    {
                        language: 'CXX',
                        compiler: {
                            path: '/usr/bin/c++',
                            commandFragment: '--target x86_64-linux-gnu',
                            id: 'GNU',
                            version: '13.2.0',
                            target: 'x86_64-linux-gnu',
                            implicit: {
                                includeDirectories: ['/usr/include/c++/13'],
                                linkDirectories: ['/usr/lib/gcc'],
                                linkFrameworkDirectories: [],
                                linkLibraries: ['stdc++'],
                            },
                        },
                        sourceFileExtensions: ['cc', 'cpp', 'cxx'],
                    },
                ],
            }), 'utf8');

            fs.writeFileSync(path.join(replyDir, 'target-app.json'), JSON.stringify({
                id: 'app::id',
                name: 'app',
                type: 'EXECUTABLE',
                imported: false,
                abstract: false,
                symbolic: false,
                isGeneratorProvided: false,
                folder: { name: 'apps' },
                paths: {
                    source: '.',
                    build: '.',
                },
                nameOnDisk: 'app.exe',
                artifacts: [{ path: 'bin/app.exe' }],
                dependencies: [{ id: 'lib::id' }],
                sources: [{ path: 'src/main.cpp' }, { path: 'src/generated.cpp', isGenerated: true }],
                interfaceSources: [{ path: 'include/api.hpp' }],
                compileGroups: [{ includes: [{ path: 'include' }, { path: '/opt/sdk/include' }] }],
                defines: [{ define: 'APP_DEFINE=1' }],
                backtraceGraph: {
                    files: ['CMakeLists.txt', 'src/CMakeLists.txt'],
                    commands: ['add_executable', 'target_sources'],
                },
            }), 'utf8');

            fs.writeFileSync(path.join(replyDir, 'codemodel-v2.json'), JSON.stringify({
                configurations: [
                    {
                        directories: [
                            { source: '.', build: '.' },
                            { source: 'src', build: 'build-src' },
                        ],
                        targets: [
                            { id: 'app::id', name: 'app', jsonFile: 'target-app.json' },
                        ],
                    },
                ],
            }), 'utf8');

            fs.writeFileSync(path.join(replyDir, 'index-zzz.json'), JSON.stringify({
                objects: [
                    { kind: 'cache', version: { major: 2, minor: 0 }, jsonFile: 'cache-v2.json' },
                    { kind: 'cmakeFiles', version: { major: 1, minor: 1 }, jsonFile: 'cmakeFiles-v1.json' },
                    { kind: 'toolchains', version: { major: 1, minor: 1 }, jsonFile: 'toolchains-v1.json' },
                    { kind: 'codemodel', version: { major: 2, minor: 8 }, jsonFile: 'codemodel-v2.json' },
                ],
            }), 'utf8');

            assert.strictEqual(await findLatestFileApiIndexFile(replyDir), 'index-zzz.json');

            const [snapshot, concurrentSnapshot] = await Promise.all([
                loadFileApiRawSnapshot(buildDir),
                loadFileApiRawSnapshot(buildDir),
            ]);
            assert.ok(snapshot !== null);
            assert.strictEqual(concurrentSnapshot, snapshot);
            assert.strictEqual(await loadFileApiRawSnapshot(buildDir), snapshot);
            assert.strictEqual(snapshot!.indexFile, 'index-zzz.json');
            assert.strictEqual(snapshot!.cacheEntriesByName.CMAKE_BUILD_TYPE.type, 'STRING');
            assert.strictEqual(snapshot!.cacheEntriesByName.CMAKE_BUILD_TYPE.help, 'Build type');
            assert.strictEqual(snapshot!.cmakeInputs.length, 2);
            assert.ok(snapshot!.globDependencies.includes('src/a.cpp'));
            assert.strictEqual(snapshot!.toolchainsByLanguage.CXX.compilerId, 'GNU');
            assert.strictEqual(snapshot!.toolchainsByLanguage.CXX.compilerCommandFragment, '--target x86_64-linux-gnu');
            assert.ok(snapshot!.toolchainsByLanguage.CXX.implicitIncludeDirectories?.includes('/usr/include/c++/13'));
            assert.ok(snapshot!.toolchainsByLanguage.CXX.implicitLinkDirectories?.includes('/usr/lib/gcc'));
            assert.ok(snapshot!.toolchainsByLanguage.CXX.implicitLinkLibraries?.includes('stdc++'));
            assert.ok(snapshot!.toolchainsByLanguage.CXX.sourceFileExtensions?.includes('cpp'));
            assert.strictEqual(snapshot!.targetsByName.app.type, 'EXECUTABLE');
            assert.ok(snapshot!.targetsByName.app.sourcePaths?.includes('src/main.cpp'));
            assert.ok(snapshot!.targetsByName.app.sourcePaths?.includes('include/api.hpp'));
            assert.ok(snapshot!.targetsByName.app.generatedSourcePaths?.includes('src/generated.cpp'));
            assert.ok(snapshot!.targetsByName.app.includeDirectories?.includes('include'));
            assert.ok(snapshot!.targetsByName.app.compileDefinitions?.includes('APP_DEFINE=1'));
            assert.ok(snapshot!.targetsByName.app.artifactPaths?.includes('bin/app.exe'));
            assert.ok(snapshot!.targetsByName.app.dependencyIds?.includes('lib::id'));
            assert.strictEqual(snapshot!.targetsByName.app.folderName, 'apps');
            assert.strictEqual(snapshot!.targetsByName.app.nameOnDisk, 'app.exe');
            assert.ok(snapshot!.targetsByName.app.backtraceFiles?.includes('CMakeLists.txt'));
            assert.ok(snapshot!.targetsByName.app.backtraceCommands?.includes('add_executable'));
            assert.strictEqual(
                snapshot!.buildDirectoriesBySourcePath?.[normalizeDirectoryMapKeyForTest(buildDir)],
                path.normalize(buildDir),
            );
            assert.strictEqual(
                snapshot!.buildDirectoriesBySourcePath?.[normalizeDirectoryMapKeyForTest(path.join(buildDir, 'src'))],
                path.join(buildDir, 'build-src'),
            );

            fs.writeFileSync(path.join(replyDir, 'cache-v3.json'), JSON.stringify({
                entries: [
                    {
                        name: 'CMAKE_BUILD_TYPE',
                        value: 'Release',
                        type: 'STRING',
                    },
                ],
            }), 'utf8');
            fs.writeFileSync(path.join(replyDir, 'index-zzzz.json'), JSON.stringify({
                objects: [
                    { kind: 'cache', version: { major: 2, minor: 0 }, jsonFile: 'cache-v3.json' },
                ],
            }), 'utf8');

            const updatedSnapshot = await loadFileApiRawSnapshot(buildDir);
            assert.ok(updatedSnapshot !== null);
            assert.notStrictEqual(updatedSnapshot, snapshot);
            assert.strictEqual(updatedSnapshot!.indexFile, 'index-zzzz.json');
            assert.strictEqual(updatedSnapshot!.cacheEntriesByName.CMAKE_BUILD_TYPE.value, 'Release');
        } finally {
            fs.rmSync(buildDir, { recursive: true, force: true });
        }
    });

    test('should preserve drive-less rooted source directories when building codemodel directory maps on Windows', async () => {
        if (process.platform !== 'win32') {
            return;
        }

        const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmake-intellisence-file-api-rootless-'));
        const replyDir = getFileApiReplyDirectory(buildDir);
        const sourceRoot = URI.parse('file:///test-workspace').fsPath;
        fs.mkdirSync(replyDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(replyDir, 'cache-v2.json'), JSON.stringify({
                entries: [
                    {
                        name: 'CMAKE_HOME_DIRECTORY',
                        value: sourceRoot,
                        type: 'INTERNAL',
                    },
                ],
            }), 'utf8');
            fs.writeFileSync(path.join(replyDir, 'codemodel-v2.json'), JSON.stringify({
                configurations: [
                    {
                        directories: [
                            { source: '.', build: '.' },
                            { source: 'src', build: 'src-build' },
                        ],
                        targets: [],
                    },
                ],
            }), 'utf8');
            fs.writeFileSync(path.join(replyDir, 'index-zzz.json'), JSON.stringify({
                objects: [
                    { kind: 'cache', version: { major: 2, minor: 0 }, jsonFile: 'cache-v2.json' },
                    { kind: 'codemodel', version: { major: 2, minor: 8 }, jsonFile: 'codemodel-v2.json' },
                ],
            }), 'utf8');

            const snapshot = await loadFileApiRawSnapshot(buildDir);
            assert.ok(snapshot !== null);
            assert.strictEqual(snapshot!.buildDirectoriesBySourcePath?.[path.normalize(sourceRoot).toLowerCase()], path.normalize(buildDir));
            assert.strictEqual(snapshot!.buildDirectoriesBySourcePath?.[path.join(sourceRoot, 'src').toLowerCase()], path.join(buildDir, 'src-build'));
        } finally {
            fs.rmSync(buildDir, { recursive: true, force: true });
        }
    });
});
