import { DependencyStructureAnalysis } from './dependencyStructure';
import { ParsedCMakeFile } from './utils';

export type SourceRevision =
    | {
        kind: 'document';
        version: number;
    }
    | {
        kind: 'disk';
        mtimeMs: number;
        ctimeMs: number;
        size: number;
    }
    | {
        kind: 'missing';
    };

export interface ParsedFileSnapshot extends ParsedCMakeFile {
    uri: string;
    revision: SourceRevision;
    dependencyStructure: DependencyStructureAnalysis;
}

type ParsedFileRequest = {
    revisionKey: string;
    request: Promise<ParsedFileSnapshot>;
};

export function sourceRevisionKey(revision: SourceRevision): string {
    switch (revision.kind) {
        case 'document':
            return `document:${revision.version}`;
        case 'disk':
            return `disk:${revision.mtimeMs}:${revision.ctimeMs}:${revision.size}`;
        case 'missing':
            return 'missing';
    }
}

export function sourceRevisionsEqual(left: SourceRevision, right: SourceRevision): boolean {
    return sourceRevisionKey(left) === sourceRevisionKey(right);
}

/**
 * Owns complete ANTLR-backed snapshots. Entries are replaced atomically per URI,
 * and in-flight analysis is coalesced per source revision.
 */
export class ParsedFileStore {
    private readonly snapshots = new Map<string, ParsedFileSnapshot>();
    private readonly requests = new Map<string, ParsedFileRequest>();

    get(uri: string): ParsedFileSnapshot | undefined {
        const snapshot = this.snapshots.get(uri);
        if (!snapshot) {
            return undefined;
        }

        // Refresh insertion order so the map can also serve as a small LRU.
        this.snapshots.delete(uri);
        this.snapshots.set(uri, snapshot);
        return snapshot;
    }

    peek(uri: string): ParsedFileSnapshot | undefined {
        return this.snapshots.get(uri);
    }

    getCurrent(uri: string, revision: SourceRevision): ParsedFileSnapshot | undefined {
        const snapshot = this.get(uri);
        return snapshot && sourceRevisionsEqual(snapshot.revision, revision)
            ? snapshot
            : undefined;
    }

    isCurrent(uri: string, revision: SourceRevision): boolean {
        const snapshot = this.snapshots.get(uri);
        return !!snapshot && sourceRevisionsEqual(snapshot.revision, revision);
    }

    async getOrCreate(
        uri: string,
        revision: SourceRevision,
        create: () => ParsedFileSnapshot | Promise<ParsedFileSnapshot>,
        onCommit?: (next: ParsedFileSnapshot, previous: ParsedFileSnapshot | undefined) => void,
    ): Promise<ParsedFileSnapshot> {
        const cached = this.getCurrent(uri, revision);
        if (cached) {
            return cached;
        }

        const revisionKey = sourceRevisionKey(revision);
        const existing = this.requests.get(uri);
        if (existing?.revisionKey === revisionKey) {
            return existing.request;
        }

        let request: Promise<ParsedFileSnapshot>;
        request = Promise.resolve()
            .then(create)
            .then(snapshot => {
                // A different revision may have started while synchronous parsing
                // was queued. Only the latest request for a URI may commit.
                if (this.requests.get(uri)?.request !== request) {
                    return snapshot;
                }
                const previous = this.snapshots.get(uri);
                if (this.shouldReplace(previous, snapshot)) {
                    this.snapshots.delete(uri);
                    this.snapshots.set(uri, snapshot);
                    onCommit?.(snapshot, previous);
                }
                return snapshot;
            })
            .finally(() => {
                if (this.requests.get(uri)?.request === request) {
                    this.requests.delete(uri);
                }
            });
        this.requests.set(uri, { revisionKey, request });
        return request;
    }

    delete(uri: string): void {
        this.snapshots.delete(uri);
        this.requests.delete(uri);
    }

    deleteWhere(predicate: (uri: string) => boolean): void {
        for (const uri of this.snapshots.keys()) {
            if (predicate(uri)) {
                this.snapshots.delete(uri);
            }
        }
        for (const uri of this.requests.keys()) {
            if (predicate(uri)) {
                this.requests.delete(uri);
            }
        }
    }

    clear(): void {
        this.snapshots.clear();
        this.requests.clear();
    }

    evictClosedSnapshots(isOpen: (uri: string) => boolean, maxClosedSnapshots: number): void {
        let closedCount = 0;
        for (const uri of this.snapshots.keys()) {
            if (!isOpen(uri)) {
                closedCount++;
            }
        }

        if (closedCount <= maxClosedSnapshots) {
            return;
        }

        for (const uri of this.snapshots.keys()) {
            if (closedCount <= maxClosedSnapshots) {
                break;
            }
            if (isOpen(uri)) {
                continue;
            }
            this.snapshots.delete(uri);
            closedCount--;
        }
    }

    private shouldReplace(
        previous: ParsedFileSnapshot | undefined,
        next: ParsedFileSnapshot,
    ): boolean {
        if (!previous) {
            return true;
        }

        if (sourceRevisionsEqual(previous.revision, next.revision)) {
            return true;
        }

        if (previous.revision.kind === 'document' && next.revision.kind === 'document') {
            return next.revision.version > previous.revision.version;
        }

        // An open-document snapshot always supersedes a disk snapshot. Conversely,
        // a disk read must not overwrite unsaved editor contents.
        if (next.revision.kind === 'document') {
            return true;
        }
        if (previous.revision.kind === 'document') {
            return false;
        }

        // Disk timestamps are identity data, not a monotonic sequence: source
        // control operations may legitimately replace a file with an older mtime.
        return true;
    }
}
