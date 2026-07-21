import * as assert from 'assert';
import { ParsedFileSnapshot, ParsedFileStore, SourceRevision } from '../../parsedFileStore';
import { parseCMakeText } from '../../utils';

function createSnapshot(uri: string, revision: SourceRevision, text: string): ParsedFileSnapshot {
    return {
        ...parseCMakeText(text),
        uri,
        revision,
        dependencyFingerprint: text,
        targetInfoFingerprint: text,
    };
}

suite('ParsedFileStore Tests', () => {
    test('coalesces analysis requests for the same source revision', async () => {
        const store = new ParsedFileStore();
        const uri = 'file:///coalesced.cmake';
        const revision: SourceRevision = { kind: 'document', version: 1 };
        let createCount = 0;

        const create = async () => {
            createCount++;
            await Promise.resolve();
            return createSnapshot(uri, revision, 'set(VALUE one)\n');
        };

        const [first, second] = await Promise.all([
            store.getOrCreate(uri, revision, create),
            store.getOrCreate(uri, revision, create),
        ]);

        assert.strictEqual(createCount, 1);
        assert.strictEqual(first, second);
        assert.strictEqual(store.getCurrent(uri, revision), first);
    });

    test('does not let an older document analysis overwrite a newer snapshot', async () => {
        const store = new ParsedFileStore();
        const uri = 'file:///ordered.cmake';
        const oldRevision: SourceRevision = { kind: 'document', version: 1 };
        const newRevision: SourceRevision = { kind: 'document', version: 2 };
        let resolveOld!: (snapshot: ParsedFileSnapshot) => void;
        let resolveNew!: (snapshot: ParsedFileSnapshot) => void;

        const oldRequest = store.getOrCreate(
            uri,
            oldRevision,
            () => new Promise(resolve => { resolveOld = resolve; }),
        );
        await Promise.resolve();
        const newRequest = store.getOrCreate(
            uri,
            newRevision,
            () => new Promise(resolve => { resolveNew = resolve; }),
        );
        await Promise.resolve();

        const newSnapshot = createSnapshot(uri, newRevision, 'set(VALUE new)\n');
        resolveNew(newSnapshot);
        await newRequest;

        resolveOld(createSnapshot(uri, oldRevision, 'set(VALUE old)\n'));
        await oldRequest;

        assert.strictEqual(store.getCurrent(uri, newRevision), newSnapshot);
        assert.strictEqual(store.getCurrent(uri, oldRevision), undefined);
    });

    test('never replaces an open-document snapshot with a disk snapshot', async () => {
        const store = new ParsedFileStore();
        const uri = 'file:///unsaved.cmake';
        const documentRevision: SourceRevision = { kind: 'document', version: 7 };
        const diskRevision: SourceRevision = { kind: 'disk', mtimeMs: 100, ctimeMs: 100, size: 20 };
        const documentSnapshot = createSnapshot(uri, documentRevision, 'set(VALUE unsaved)\n');

        await store.getOrCreate(uri, documentRevision, () => documentSnapshot);
        await store.getOrCreate(
            uri,
            diskRevision,
            () => createSnapshot(uri, diskRevision, 'set(VALUE disk)\n'),
        );

        assert.strictEqual(store.getCurrent(uri, documentRevision), documentSnapshot);
    });

    test('a missing-file revision can replace a stale disk snapshot', async () => {
        const store = new ParsedFileStore();
        const uri = 'file:///deleted.cmake';
        const diskRevision: SourceRevision = { kind: 'disk', mtimeMs: 100, ctimeMs: 100, size: 20 };
        const missingRevision: SourceRevision = { kind: 'missing' };

        await store.getOrCreate(
            uri,
            diskRevision,
            () => createSnapshot(uri, diskRevision, 'set(VALUE disk)\n'),
        );
        const missingSnapshot = createSnapshot(uri, missingRevision, '');
        await store.getOrCreate(uri, missingRevision, () => missingSnapshot);

        assert.strictEqual(store.getCurrent(uri, missingRevision), missingSnapshot);
    });

    test('accepts a current disk revision even when its mtime moved backwards', async () => {
        const store = new ParsedFileStore();
        const uri = 'file:///checkout.cmake';
        const newerMtime: SourceRevision = { kind: 'disk', mtimeMs: 200, ctimeMs: 200, size: 20 };
        const olderMtime: SourceRevision = { kind: 'disk', mtimeMs: 100, ctimeMs: 300, size: 20 };

        await store.getOrCreate(
            uri,
            newerMtime,
            () => createSnapshot(uri, newerMtime, 'set(VALUE first)\n'),
        );
        const checkedOutSnapshot = createSnapshot(uri, olderMtime, 'set(VALUE checked-out)\n');
        await store.getOrCreate(uri, olderMtime, () => checkedOutSnapshot);

        assert.strictEqual(store.getCurrent(uri, olderMtime), checkedOutSnapshot);
    });

    test('deleting an entry prevents an in-flight analysis from committing later', async () => {
        const store = new ParsedFileStore();
        const uri = 'file:///removed.cmake';
        const revision: SourceRevision = { kind: 'document', version: 1 };
        let resolveRequest!: (snapshot: ParsedFileSnapshot) => void;

        const request = store.getOrCreate(
            uri,
            revision,
            () => new Promise(resolve => { resolveRequest = resolve; }),
        );
        await Promise.resolve();
        store.delete(uri);
        resolveRequest(createSnapshot(uri, revision, 'set(VALUE stale)\n'));
        await request;

        assert.strictEqual(store.peek(uri), undefined);
    });

    test('evicts only closed snapshots when enforcing the closed-file budget', async () => {
        const store = new ParsedFileStore();
        const openUri = 'file:///open.cmake';
        const firstClosedUri = 'file:///closed-1.cmake';
        const secondClosedUri = 'file:///closed-2.cmake';
        const revision: SourceRevision = { kind: 'document', version: 1 };

        await store.getOrCreate(openUri, revision, () => createSnapshot(openUri, revision, 'set(A 1)\n'));
        await store.getOrCreate(firstClosedUri, revision, () => createSnapshot(firstClosedUri, revision, 'set(B 1)\n'));
        await store.getOrCreate(secondClosedUri, revision, () => createSnapshot(secondClosedUri, revision, 'set(C 1)\n'));

        store.evictClosedSnapshots(uri => uri === openUri, 1);

        assert(store.peek(openUri));
        assert.strictEqual(store.peek(firstClosedUri), undefined);
        assert(store.peek(secondClosedUri));
    });
});
