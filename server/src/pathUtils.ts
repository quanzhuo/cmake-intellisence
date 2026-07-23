import * as path from 'path';

function normalizePathForComparison(filePath: string): string {
    const normalized = path.resolve(filePath);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function isPathEqualOrInside(parentPath: string, candidatePath: string): boolean {
    const relative = path.relative(
        normalizePathForComparison(parentPath),
        normalizePathForComparison(candidatePath),
    );
    return relative === ''
        || (relative !== '..'
            && !relative.startsWith(`..${path.sep}`)
            && !path.isAbsolute(relative));
}
