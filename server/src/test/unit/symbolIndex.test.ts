import * as assert from 'assert';
import { FileSymbolCache, SymbolIndex } from '../../symbolIndex';

suite('Symbol Index Tests', () => {
    test('tracks the source revision associated with a file cache', () => {
        const symbolIndex = new SymbolIndex();
        const uri = 'file:///versioned.cmake';
        const cache = new FileSymbolCache(uri);

        symbolIndex.setCache(uri, cache, 'document:3');

        assert.strictEqual(symbolIndex.hasCurrentCache(uri, 'document:3'), true);
        assert.strictEqual(symbolIndex.hasCurrentCache(uri, 'document:2'), false);
        assert.strictEqual(symbolIndex.getCacheRevisionKey(uri), 'document:3');

        symbolIndex.deleteCache(uri);
        assert.strictEqual(symbolIndex.getCacheRevisionKey(uri), undefined);
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
            assert.deepStrictEqual(visibleFiles, []);
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
});
