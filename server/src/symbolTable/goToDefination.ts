import CMakeListener from "../parser/CMakeListener";
import CMakeLexer from "../parser/CMakeLexer";
import CMakeParser from "../parser/CMakeParser";
import antlr4 from '../parser/antlr4/index.js';
import { documents } from "../server";
import { Location } from "vscode-languageserver-types";

export const definations: Map<string, Location> = new Map();

export class DefinationListener extends CMakeListener {
    private fileScope: FileScope;
    private currentScope: Scope;
    private inFunction = false;

    constructor(parentScope) {
        super();
        this.fileScope = parentScope;
        this.currentScope = this.fileScope;
    }


    enterFile(ctx: any): void {
        
    }

    enterFunctionCmd(ctx: any): void {
        this.inFunction = true;        
    }

    exitEndFunctionCmd(ctx: any): void {
        this.inFunction = false;
    }

    enterSetCmd(ctx: any): void {
        
    }

    enterIncludeCmd(ctx: any): void {
        // FIXME: placeholders, please fix the include fileUri
        const fileUri: string = "include-filename";
        const document = documents.get(fileUri);
        const input = antlr4.CharStreams.fromString(document.getText());
        const lexer = new CMakeLexer(input);
        const tokenStream = new antlr4.CommonTokenStream(lexer);
        const parser = new CMakeParser(tokenStream);
        const tree = parser.file();
        
    }

    enterAddSubDirCmd(ctx: any): void {
        
    }
}