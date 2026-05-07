import * as assert from 'assert';
import { FileSymbolCache, SymbolIndex } from '../../symbolIndex';

suite('Symbol Index Tests', () => {
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
});