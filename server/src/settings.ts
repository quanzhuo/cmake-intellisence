import antlr4 from "./parser/antlr4";
import CMakeLexer from "./parser/CMakeLexer";
import CMakeParser from "./parser/CMakeParser";
import SemanticDiagnosticsListener from "./semanticDiagnostics";
import { connection, documents } from "./server";
import SyntaxErrorListener from "./syntaxDiagnostics";

export default class ExtensionSettings {
    public loggingLevel: string;
    public cmakePath: string;
    public cmdCaseDiagnostics: string;

    public async getSettings() {
        let oldCmdCaseSetting = this.cmdCaseDiagnostics;

        [
            this.cmakePath,
            this.loggingLevel,
            this.cmdCaseDiagnostics
        ] = await connection.workspace.getConfiguration([
            { section: 'cmakeIntelliSence.cmakePath' },
            { section: 'cmakeIntelliSence.loggingLevel' },
            { section: 'cmakeIntelliSence.cmdCaseDiagnostics' }
        ]);

        if (oldCmdCaseSetting !== this.cmdCaseDiagnostics) {
            documents.all().forEach(element => {
                const input = antlr4.CharStreams.fromString(element.getText());
                const lexer = new CMakeLexer(input);
                const tokenStream = new antlr4.CommonTokenStream(lexer);
                const parser = new CMakeParser(tokenStream);
                parser.removeErrorListeners();
                const syntaxErrorListener = new SyntaxErrorListener();
                parser.addErrorListener(syntaxErrorListener);
                const tree = parser.file();
                const semanticListener = new SemanticDiagnosticsListener();
                antlr4.tree.ParseTreeWalker.DEFAULT.walk(semanticListener, tree);
                connection.sendDiagnostics({
                    uri: element.uri,
                    diagnostics: [
                        ...syntaxErrorListener.getSyntaxErrors(),
                        ...semanticListener.getSemanticDiagnostics()
                    ]
                });
            });
        }
    }
}

export enum CmdCaseDiagnostics {
    None = "none",
    Builtin = 'builtin',
    All = 'all'
}

export const extSettings: ExtensionSettings = new ExtensionSettings();