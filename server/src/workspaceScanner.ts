import * as fs from 'fs';
import * as path from 'path';
import { isPathEqualOrInside } from './pathUtils';

export interface WorkspaceCMakeFilePolicyOptions {
    ignoredDirectoryNames: readonly string[];
    excludeCMakeBuildDirectories?: boolean;
    excludedDirectoryPaths?: readonly string[];
}

export class WorkspaceCMakeFilePolicy {
    private readonly normalizedRoot: string;
    private readonly ignoredDirectoryNames: Set<string>;
    private readonly excludedDirectoryPaths: string[];

    constructor(
        private readonly rootPath: string,
        private readonly options: WorkspaceCMakeFilePolicyOptions,
    ) {
        this.normalizedRoot = this.normalizePath(rootPath);
        this.ignoredDirectoryNames = new Set(options.ignoredDirectoryNames.map(name => this.normalizeName(name)));
        this.excludedDirectoryPaths = (options.excludedDirectoryPaths ?? []).map(directory => this.normalizePath(directory));
    }

    async accepts(filePath: string): Promise<boolean> {
        if (!this.isCMakeFileName(path.basename(filePath)) || !this.isInsideRoot(filePath)) {
            return false;
        }

        let directoryPath = path.dirname(path.resolve(filePath));
        while (this.isInsideRoot(directoryPath)) {
            if (await this.shouldExcludeDirectory(directoryPath)) {
                return false;
            }
            if (this.normalizePath(directoryPath) === this.normalizedRoot) {
                break;
            }
            directoryPath = path.dirname(directoryPath);
        }
        return true;
    }

    async collectFiles(): Promise<string[]> {
        const results: string[] = [];
        const visit = async (directoryPath: string): Promise<void> => {
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
            } catch {
                return;
            }
            if (await this.shouldExcludeDirectory(directoryPath, entries)) {
                return;
            }

            for (const entry of entries) {
                if (entry.isSymbolicLink()) {
                    continue;
                }
                const fullPath = path.join(directoryPath, entry.name);
                if (entry.isDirectory()) {
                    await visit(fullPath);
                } else if (entry.isFile() && this.isCMakeFileName(entry.name)) {
                    results.push(fullPath);
                }
            }
        };

        await visit(this.rootPath);
        return results;
    }

    private isCMakeFileName(fileName: string): boolean {
        return fileName === 'CMakeLists.txt' || fileName.endsWith('.cmake');
    }

    private normalizeName(name: string): string {
        return process.platform === 'win32' ? name.toLowerCase() : name;
    }

    private normalizePath(fsPath: string): string {
        const normalized = path.resolve(fsPath);
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    }

    private isInsideRoot(candidatePath: string): boolean {
        return isPathEqualOrInside(this.normalizedRoot, this.normalizePath(candidatePath));
    }

    private async shouldExcludeDirectory(directoryPath: string, entries?: fs.Dirent[]): Promise<boolean> {
        const normalizedDirectory = this.normalizePath(directoryPath);
        if (this.excludedDirectoryPaths.some(excluded => isPathEqualOrInside(excluded, normalizedDirectory))) {
            return true;
        }
        if (normalizedDirectory !== this.normalizedRoot
            && this.ignoredDirectoryNames.has(this.normalizeName(path.basename(directoryPath)))) {
            return true;
        }
        if (this.options.excludeCMakeBuildDirectories === false) {
            return false;
        }

        try {
            const directoryEntries = entries ?? await fs.promises.readdir(directoryPath, { withFileTypes: true });
            return directoryEntries.some(entry => entry.isFile() && entry.name === 'CMakeCache.txt')
                && directoryEntries.some(entry => entry.isDirectory() && entry.name === 'CMakeFiles');
        } catch {
            return false;
        }
    }
}
