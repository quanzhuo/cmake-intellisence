import * as assert from 'assert';
import { ExtensionSettings } from '../../cmakeEnvironment';
import { resolveExtensionSettings } from '../../config';

suite('configuration tests', () => {
    const defaults: ExtensionSettings = {
        cmakePath: 'cmake',
        loggingLevel: 'off',
        cmdCaseDiagnostics: false,
        pkgConfigPath: 'pkg-config',
        workspaceIgnoreDirectories: ['.git', 'build'],
        excludeCMakeBuildDirectories: true,
    };

    test('normalizes configured values', () => {
        const resolved = resolveExtensionSettings({
            cmakePath: '/usr/bin/cmake',
            loggingLevel: 'debug',
            cmdCaseDiagnostics: true,
            pkgConfigPath: '/usr/bin/pkg-config',
            workspaceIgnoreDirectories: ['dist', ' out '],
            excludeCMakeBuildDirectories: false,
        }, defaults);

        assert.deepStrictEqual(resolved, {
            cmakePath: '/usr/bin/cmake',
            loggingLevel: 'debug',
            cmdCaseDiagnostics: true,
            pkgConfigPath: '/usr/bin/pkg-config',
            workspaceIgnoreDirectories: ['dist', 'out'],
            excludeCMakeBuildDirectories: false,
        });
    });

    test('uses defaults for missing or invalid values', () => {
        assert.deepStrictEqual(resolveExtensionSettings(undefined, defaults), defaults);
        assert.deepStrictEqual(resolveExtensionSettings({ workspaceIgnoreDirectories: [false] }, defaults), defaults);
    });
});
