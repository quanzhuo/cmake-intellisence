import * as assert from 'assert';
import * as path from 'path';
import { isPathEqualOrInside } from '../../pathUtils';

suite('path utilities', () => {
    const rootPath = path.resolve('path-utils-root');

    test('accepts the root and descendants', () => {
        assert.strictEqual(isPathEqualOrInside(rootPath, rootPath), true);
        assert.strictEqual(isPathEqualOrInside(rootPath, path.join(rootPath, 'sub', 'file.cmake')), true);
    });

    test('accepts descendant names beginning with two dots', () => {
        assert.strictEqual(isPathEqualOrInside(rootPath, path.join(rootPath, '..hidden.cmake')), true);
        assert.strictEqual(isPathEqualOrInside(rootPath, path.join(rootPath, '..hidden', 'file.cmake')), true);
    });

    test('rejects parent and sibling paths', () => {
        assert.strictEqual(isPathEqualOrInside(rootPath, path.dirname(rootPath)), false);
        assert.strictEqual(isPathEqualOrInside(rootPath, `${rootPath}-other`), false);
    });
});
