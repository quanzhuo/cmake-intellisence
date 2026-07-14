import * as fs from 'fs';
import * as path from 'path';

const CMAKE_CACHE_FILE = 'CMakeCache.txt';

export async function collectWorkspaceCMakeFiles(
    rootPath: string,
    ignoredDirectoryNames: readonly string[],
    excludeCMakeBuildDirectories = true,
): Promise<string[]> {
    const results: string[] = [];
    const ignoredDirectories = new Set(ignoredDirectoryNames);

    const visit = async (dirPath: string): Promise<void> => {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        const isCMakeBuildDirectory = excludeCMakeBuildDirectories
            && entries.some(entry => entry.isFile() && entry.name === CMAKE_CACHE_FILE)
            && entries.some(entry => entry.isDirectory() && entry.name === 'CMakeFiles');
        if (isCMakeBuildDirectory) {
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isSymbolicLink()) {
                continue;
            }
            if (entry.isDirectory()) {
                if (ignoredDirectories.has(entry.name)) {
                    continue;
                }
                await visit(fullPath);
                continue;
            }
            if (!entry.isFile()) {
                continue;
            }
            if (entry.name === 'CMakeLists.txt' || entry.name.endsWith('.cmake')) {
                results.push(fullPath);
            }
        }
    };

    await visit(rootPath);
    return results;
}
