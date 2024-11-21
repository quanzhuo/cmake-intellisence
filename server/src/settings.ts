import { connection } from "./server";

export default class ExtensionSettings {
    public loggingLevel: string;
    public cmakePath: string;
    public cmdCaseDiagnostics: boolean;

    public async getSettings() {
        [
            this.cmakePath,
            this.loggingLevel,
            this.cmdCaseDiagnostics
        ] = await connection.workspace.getConfiguration([
            { section: 'cmakeIntelliSence.cmakePath' },
            { section: 'cmakeIntelliSence.loggingLevel' },
            { section: 'cmakeIntelliSence.cmdCaseDiagnostics' }
        ]);
    }
}

export const extSettings: ExtensionSettings = new ExtensionSettings();