import { connection } from "./server";

export default class ExtensionSettings {
    public loggingLevel: string;
    public cmakePath: string;

    public async getSettings() {
        [this.cmakePath, this.loggingLevel] = await connection.workspace.getConfiguration([
            { section: 'cmakeIntelliSence.cmakePath' },
            { section: 'cmakeIntelliSence.loggingLevel' }
        ]);
    }
}

export const extSettings: ExtensionSettings = new ExtensionSettings();