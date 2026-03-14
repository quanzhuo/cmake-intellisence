import { RenameParams, TextEdit, WorkspaceEdit } from "vscode-languageserver";
import { throwIfCancelled } from "./cancellation";
import { ReferenceResolver } from "./references";

export class RenameResolver {
    constructor(private refResolver: ReferenceResolver) { }

    public async resolve(params: RenameParams, shouldCancel?: () => boolean): Promise<WorkspaceEdit | null> {
        throwIfCancelled(shouldCancel);
        // 重命名就是找到所有的引用（包含定义声明本身），并统一下发文本替换指令
        const locations = await this.refResolver.resolve({
            textDocument: params.textDocument,
            position: params.position,
            context: { includeDeclaration: true }
        });
        throwIfCancelled(shouldCancel);

        if (!locations || locations.length === 0) {
            return null;
        }

        const changes: { [uri: string]: TextEdit[] } = {};
        for (const loc of locations) {
            throwIfCancelled(shouldCancel);
            if (!changes[loc.uri]) {
                changes[loc.uri] = [];
            }
            changes[loc.uri].push({
                range: loc.range,
                newText: params.newName
            });
        }

        return { changes };
    }
}

