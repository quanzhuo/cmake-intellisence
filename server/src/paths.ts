import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export async function mkdir_p(fsPath: string): Promise<void> {
    await fs.promises.mkdir(fsPath, { recursive: true });
}

class Paths {
    get dataDir(): string {
        const userDataDirectory = process.platform === 'win32'
            ? process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
            : process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
        return path.join(userDataDirectory, 'cmake-intellisense');
    }
}

export default new Paths();
