import { promises as fsPromises } from 'fs';
import * as path from 'path';
import { FileApiCacheEntrySnapshot } from './fileApiSnapshot';

export type CMakeCacheEntriesByName = Record<string, FileApiCacheEntrySnapshot>;

export function parseCMakeCacheEntries(content: string): CMakeCacheEntriesByName {
    const entries: CMakeCacheEntriesByName = {};
    let pendingHelp: string | undefined;

    for (const line of content.split(/\r?\n/)) {
        if (line.trim().length === 0) {
            pendingHelp = undefined;
            continue;
        }

        if (line.startsWith('//')) {
            pendingHelp = line.slice(2).trim() || undefined;
            continue;
        }

        if (line.startsWith('#')) {
            pendingHelp = undefined;
            continue;
        }

        const typeSeparator = line.indexOf(':');
        const valueSeparator = line.indexOf('=');
        if (typeSeparator <= 0 || valueSeparator <= typeSeparator) {
            pendingHelp = undefined;
            continue;
        }

        const name = line.slice(0, typeSeparator);
        const type = line.slice(typeSeparator + 1, valueSeparator);
        const value = line.slice(valueSeparator + 1);
        const nextEntry: FileApiCacheEntrySnapshot = {
            name,
            type: type || undefined,
            value,
            help: pendingHelp,
        };

        const existing = entries[name];
        if (!existing || (existing.type === 'INTERNAL' && nextEntry.type !== 'INTERNAL')) {
            entries[name] = nextEntry;
        } else if (!existing.help && nextEntry.help) {
            existing.help = nextEntry.help;
        }

        pendingHelp = undefined;
    }

    return entries;
}

export async function loadCMakeCacheEntries(buildDirectory: string): Promise<CMakeCacheEntriesByName> {
    const cmakeCacheFile = path.join(buildDirectory, 'CMakeCache.txt');
    try {
        const content = await fsPromises.readFile(cmakeCacheFile, 'utf8');
        return parseCMakeCacheEntries(content);
    } catch {
        return {};
    }
}

export function getCacheEntryByName(
    entriesByName: CMakeCacheEntriesByName | undefined,
    variableName: string,
): FileApiCacheEntrySnapshot | undefined {
    if (!entriesByName || !variableName) {
        return undefined;
    }

    const exactMatch = entriesByName[variableName];
    if (exactMatch) {
        return exactMatch;
    }

    const expectedName = variableName.toLowerCase();
    for (const [name, entry] of Object.entries(entriesByName)) {
        if (name.toLowerCase() === expectedName) {
            return entry;
        }
    }

    return undefined;
}