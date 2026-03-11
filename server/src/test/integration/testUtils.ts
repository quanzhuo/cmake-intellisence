import { ProtocolConnection } from 'vscode-languageserver-protocol/node';
import { READY_NOTIFICATION } from '../../testing';

export function waitForServerReady(connection: ProtocolConnection, timeout = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            readySubscription.dispose();
            reject(new Error(`Timeout waiting for server ready notification: ${READY_NOTIFICATION}`));
        }, timeout);

        const readySubscription = connection.onNotification(READY_NOTIFICATION, () => {
            clearTimeout(timer);
            readySubscription.dispose();
            resolve();
        });
    });
}