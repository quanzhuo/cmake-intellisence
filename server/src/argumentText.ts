export function isBracketArgumentText(text: string): boolean {
    return /^\[(=*)\[[\s\S]*\]\1\]$/.test(text);
}
