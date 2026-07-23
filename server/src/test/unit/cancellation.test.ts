import * as assert from 'assert';
import { CancellationTokenSource } from 'vscode-jsonrpc';
import { RequestCancelledError, waitForCancellation } from '../../cancellation';

suite('Cancellation Tests', () => {
    test('waitForCancellation should reject without waiting for shared work to finish', async () => {
        const source = new CancellationTokenSource();
        const request = new Promise<string>(() => undefined);
        const result = waitForCancellation(request, source.token);

        source.cancel();

        await assert.rejects(result, error => error instanceof RequestCancelledError);
        source.dispose();
    });
});
