import * as assert from 'assert';
import { FileSymbolCache, SymbolIndex } from '../../symbolIndex';
import { ensureSymbolIndexCache, populateIndexTopDown } from '../../symbolIndexManager';

suite('Symbol Index Tests', () => {
    test('tracks the source revision and project entry associated with a file cache', () => {
        const symbolIndex = new SymbolIndex();
        const uri = 'file:///versioned.cmake';
        const cache = new FileSymbolCache(uri);

        symbolIndex.setCache(uri, cache, 'document:3', 'file:///project/CMakeLists.txt');

        assert.strictEqual(symbolIndex.hasCurrentCache(uri, 'document:3'), true);
        assert.strictEqual(symbolIndex.hasCurrentCache(uri, 'document:3', 'file:///project/CMakeLists.txt'), true);
        assert.strictEqual(symbolIndex.hasCurrentCache(uri, 'document:3', 'file:///other/CMakeLists.txt'), false);
        assert.strictEqual(symbolIndex.hasCurrentCache(uri, 'document:2'), false);
        assert.strictEqual(symbolIndex.getCacheRevisionKey(uri), 'document:3');
        assert.strictEqual(symbolIndex.hasDependencyContext(uri, 'file:///project/CMakeLists.txt'), true);

        symbolIndex.deleteCache(uri);
        assert.strictEqual(symbolIndex.getCacheRevisionKey(uri), undefined);
        assert.strictEqual(symbolIndex.hasDependencyContext(uri, 'file:///project/CMakeLists.txt'), false);
    });

    test('getCache should refresh LRU order before eviction', () => {
        const symbolIndex = new SymbolIndex(2);
        const cacheA = new FileSymbolCache('file:///a.cmake');
        const cacheB = new FileSymbolCache('file:///b.cmake');
        const cacheC = new FileSymbolCache('file:///c.cmake');

        symbolIndex.setCache(cacheA.uri, cacheA);
        symbolIndex.setCache(cacheB.uri, cacheB);
        assert.strictEqual(symbolIndex.getCache(cacheA.uri), cacheA);

        symbolIndex.setCache(cacheC.uri, cacheC);

        assert.strictEqual(symbolIndex.getCache(cacheA.uri), cacheA);
        assert.strictEqual(symbolIndex.getCache(cacheB.uri), undefined);
        assert.strictEqual(symbolIndex.getCache(cacheC.uri), cacheC);
    });

    test('project traversal should rebuild a source cache created for another entry file', async () => {
        const symbolIndex = new SymbolIndex();
        const uri = 'file:///project/child.cmake';
        const rootEntry = 'file:///project/CMakeLists.txt';
        symbolIndex.setCache(uri, new FileSymbolCache(uri), 'disk:1', uri);

        let requestedEntry: string | undefined;
        const available = await ensureSymbolIndexCache(
            symbolIndex,
            async () => undefined,
            uri,
            rootEntry,
            undefined,
            async (targetUri, entryFile) => {
                requestedEntry = entryFile;
                symbolIndex.setCache(targetUri, new FileSymbolCache(targetUri), 'disk:1', entryFile);
                return true;
            },
        );

        assert.strictEqual(available, true);
        assert.strictEqual(requestedEntry, rootEntry);
        assert.strictEqual(symbolIndex.hasCurrentCache(uri, 'disk:1', rootEntry), true);
    });

    test('project traversal should index a dependency that has no cache yet', async () => {
        const symbolIndex = new SymbolIndex();
        const uri = 'file:///project/new-dependency.cmake';
        const rootEntry = 'file:///project/CMakeLists.txt';
        let indexed = false;

        const available = await ensureSymbolIndexCache(
            symbolIndex,
            async () => undefined,
            uri,
            rootEntry,
            undefined,
            async (targetUri, entryFile) => {
                indexed = true;
                symbolIndex.setCache(targetUri, new FileSymbolCache(targetUri), 'disk:1', entryFile);
                return true;
            },
        );

        assert.strictEqual(available, true);
        assert.strictEqual(indexed, true);
    });

    test('dependency traversal should preserve an explicit project entry when starting from a child file', async () => {
        const symbolIndex = new SymbolIndex();
        const projectEntry = 'file:///project/CMakeLists.txt';
        const childUri = 'file:///project/child.cmake';
        const dependencyUri = 'file:///project/dependency.cmake';
        const childCache = new FileSymbolCache(childUri);
        childCache.addDependency(dependencyUri, 'include');
        symbolIndex.setCache(childUri, childCache, 'disk:1', projectEntry);
        symbolIndex.setCache(
            dependencyUri,
            new FileSymbolCache(dependencyUri),
            'disk:1',
            dependencyUri,
        );

        let requestedEntry: string | undefined;
        await populateIndexTopDown({
            rootUri: childUri,
            entryFile: projectEntry,
            symbolIndex,
            loadFlatCommands: async () => undefined,
            ensureFileIndexed: async (targetUri, entryFile) => {
                if (targetUri === dependencyUri) {
                    requestedEntry = entryFile;
                }
                symbolIndex.setCache(
                    targetUri,
                    symbolIndex.getCache(targetUri) ?? new FileSymbolCache(targetUri),
                    'disk:1',
                    entryFile,
                );
                return true;
            },
        });

        assert.strictEqual(requestedEntry, projectEntry);
        assert.strictEqual(symbolIndex.hasDependencyContext(dependencyUri, projectEntry), true);
    });

    test('default cache retains the complete compact workspace index', () => {
        const symbolIndex = new SymbolIndex();
        const fileCount = 2050;

        for (let index = 0; index < fileCount; index++) {
            const uri = `file:///workspace/${index}.cmake`;
            symbolIndex.setCache(uri, new FileSymbolCache(uri));
        }

        assert.strictEqual(symbolIndex.getAllCaches().length, fileCount);
        assert(symbolIndex.getCache('file:///workspace/0.cmake'));
    });

    test('getVisibleFilesForVariable should tolerate deep include chains without recursion overflow', () => {
        const symbolIndex = new SymbolIndex();
        const rootUri = 'file:///root.cmake';
        const depth = 150;

        for (let index = 0; index <= depth; index++) {
            const uri = index === 0 ? rootUri : `file:///include-${index}.cmake`;
            const cache = new FileSymbolCache(uri);
            if (index < depth) {
                const nextUri = `file:///include-${index + 1}.cmake`;
                cache.addDependency(nextUri, 'include');
            }
            symbolIndex.setCache(uri, cache);
        }

        assert.doesNotThrow(() => {
            const visibleFiles = symbolIndex.getVisibleFilesForVariable(rootUri, `file:///include-${depth}.cmake`);
            assert.strictEqual(visibleFiles.length, depth + 1);
            assert.strictEqual(visibleFiles[0], rootUri);
            assert.strictEqual(visibleFiles[depth], `file:///include-${depth}.cmake`);
        });
    });

    test('entry and reachability queries should tolerate deep dependency graphs', () => {
        const symbolIndex = new SymbolIndex();
        const depth = 5000;
        const rootUri = 'file:///deep/root.cmake';

        for (let index = 0; index <= depth; index++) {
            const uri = index === 0 ? rootUri : `file:///deep/include-${index}.cmake`;
            const cache = new FileSymbolCache(uri);
            if (index < depth) {
                cache.addDependency(`file:///deep/include-${index + 1}.cmake`, 'include');
            }
            symbolIndex.setCache(uri, cache);
        }

        const leafUri = `file:///deep/include-${depth}.cmake`;
        assert.strictEqual(symbolIndex.getReachableFiles(rootUri).length, depth + 1);
        assert.strictEqual(symbolIndex.findEntryFile(leafUri), rootUri);
    });

    test('project context should take precedence over a standalone file context', () => {
        const symbolIndex = new SymbolIndex();
        const rootUri = 'file:///workspace/CMakeLists.txt';
        const childUri = 'file:///workspace/child.cmake';
        const childCache = new FileSymbolCache(childUri);
        symbolIndex.setCache(childUri, childCache, 'document:1', childUri);

        const rootCache = new FileSymbolCache(rootUri);
        rootCache.addDependency(childUri, 'include');
        symbolIndex.setCache(rootUri, rootCache, 'document:1', rootUri);
        symbolIndex.setCache(childUri, childCache, 'document:1', rootUri);

        assert.strictEqual(symbolIndex.findEntryFile(childUri), rootUri);
    });

    test('reports every project entry associated with a shared file', () => {
        const symbolIndex = new SymbolIndex();
        const sharedUri = 'file:///workspace/shared.cmake';
        const firstEntry = 'file:///workspace/first/CMakeLists.txt';
        const secondEntry = 'file:///workspace/second/CMakeLists.txt';
        const cache = new FileSymbolCache(sharedUri);

        symbolIndex.setCache(sharedUri, cache, 'disk:1', firstEntry);
        symbolIndex.setCache(sharedUri, cache, 'disk:1', secondEntry);

        assert.deepStrictEqual(
            symbolIndex.getProjectEntriesForUri(sharedUri).sort(),
            [firstEntry, secondEntry].sort(),
        );

        symbolIndex.clearProjectContext(firstEntry);
        assert.deepStrictEqual(symbolIndex.getProjectEntriesForUri(sharedUri), [secondEntry]);
        assert.strictEqual(symbolIndex.getCache(sharedUri), cache);
    });

    test('resolves project dependency input references transitively across files', () => {
        const symbolIndex = new SymbolIndex();
        const entryUri = 'file:///workspace/CMakeLists.txt';
        const childUri = 'file:///workspace/child.cmake';
        const leafUri = 'file:///workspace/leaf.cmake';
        const entryCache = new FileSymbolCache(entryUri);
        const childCache = new FileSymbolCache(childUri);
        const leafCache = new FileSymbolCache(leafUri);
        entryCache.addDependency(childUri, 'include');
        entryCache.addDependencyInputVariable('ROUTE_FILE');
        childCache.addDependency(leafUri, 'include');
        childCache.addVariableValueReference('ROUTE_FILE', 'ROUTE_DIR');
        leafCache.addVariableValueReference('ROUTE_DIR', 'ROUTE_ROOT');

        symbolIndex.setCache(entryUri, entryCache, 'disk:1', entryUri);
        symbolIndex.setCache(childUri, childCache, 'disk:1', entryUri);
        symbolIndex.setCache(leafUri, leafCache, 'disk:1', entryUri);

        assert.deepStrictEqual(
            Array.from(symbolIndex.getProjectDependencyInputVariables(entryUri)).sort(),
            ['ROUTE_DIR', 'ROUTE_FILE', 'ROUTE_ROOT'],
        );
    });

    test('can retain stable dependency edges while replacing a file recovered from syntax errors', () => {
        const symbolIndex = new SymbolIndex();
        const rootUri = 'file:///workspace/CMakeLists.txt';
        const dependencyUri = 'file:///workspace/stable.cmake';
        const stableCache = new FileSymbolCache(rootUri);
        stableCache.addDependency(dependencyUri, 'include');
        symbolIndex.setCache(dependencyUri, new FileSymbolCache(dependencyUri));
        symbolIndex.setCache(rootUri, stableCache, 'document:1', rootUri);

        symbolIndex.deleteCache(rootUri, { retainDependencyContexts: true });
        const recoveredCache = new FileSymbolCache(rootUri);
        symbolIndex.setCache(
            rootUri,
            recoveredCache,
            'document:2',
            rootUri,
            { preserveDependencyContexts: true },
        );

        assert.strictEqual(symbolIndex.getCache(rootUri), recoveredCache);
        assert.deepStrictEqual(
            symbolIndex.getAvailableDependencies(rootUri, rootUri).map(dependency => dependency.uri),
            [dependencyUri],
        );
        assert.strictEqual(symbolIndex.hasCurrentCache(rootUri, 'document:2', rootUri), true);
    });
});
