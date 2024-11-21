import { Connection } from "vscode-languageserver";

export default class ExtensionSettings {
    public loggingLevel: string;
    public cmakePath: string;
    public cmdCaseDiagnostics: boolean;

    public async getSettings(connection: Connection) {
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