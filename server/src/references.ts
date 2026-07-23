import { Location, ReferenceParams } from 'vscode-languageserver';
import { DefinitionSubject } from './argumentSemantics';
import { ReferenceBinding, SymbolBindingResolver } from './symbolBinding';
import { SymbolNamespace } from './symbolIndex';
import { SymbolResolverBase } from './symbolResolverBase';

export class ReferenceResolver extends SymbolResolverBase {
    public async resolveBinding(params: ReferenceParams): Promise<ReferenceBinding | null> {
        const document = this.documents.get(params.textDocument.uri);
        if (!document) {
            return null;
        }

        await this.determineContextAndRoot();
        const cursorTarget = this.getResolvedCursorTarget(document, params.position);
        if (!cursorTarget) {
            return null;
        }

        const namespace = this.getNamespace(cursorTarget.subject);
        if (!namespace) {
            return null;
        }

        const bindingResolver = new SymbolBindingResolver(
            this.symbolIndex,
            this.entryFile.toString(),
            this.curFile.toString(),
        );
        let occurrence = bindingResolver.findOccurrenceAt(params.position, namespace);
        if (!occurrence && cursorTarget.subject === DefinitionSubject.Variable) {
            occurrence = bindingResolver.findOccurrenceAt(params.position, 'cache-variable')
                ?? bindingResolver.findOccurrenceAt(params.position, 'environment-variable');
        }
        if (!occurrence) {
            return null;
        }

        return bindingResolver.findReferences(occurrence, params.context.includeDeclaration);
    }

    public async resolve(params: ReferenceParams): Promise<Location[] | null> {
        const binding = await this.resolveBinding(params);
        return binding && binding.locations.length > 0 ? binding.locations : null;
    }

    private getNamespace(subject: DefinitionSubject): SymbolNamespace | null {
        switch (subject) {
            case DefinitionSubject.Command:
                return 'command';
            case DefinitionSubject.Target:
                return 'target';
            case DefinitionSubject.Variable:
                return 'variable';
            default:
                return null;
        }
    }
}
