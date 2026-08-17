/**
 * Client-safe rendering helpers for stored Wikipedia section text (GROK P1:
 * raw `=== Subhead ===` markers must never reach the page as body copy).
 * Stored text keeps the wiki markers (server stays presentation-agnostic);
 * this parser turns them into structured blocks at render time.
 */
export interface WikiBlock {
	kind: 'sub' | 'p';
	text: string;
}

const SUBHEAD_RE = /^=+\s*(.*?)\s*=+$/;

export function sectionBlocks(text: string): WikiBlock[] {
	const blocks: WikiBlock[] = [];
	let para: string[] = [];
	const flush = () => {
		const joined = para.join('\n').trim();
		if (joined) blocks.push({ kind: 'p', text: joined });
		para = [];
	};
	for (const line of text.split('\n')) {
		const m = SUBHEAD_RE.exec(line.trim());
		if (m) {
			flush();
			if (m[1]) blocks.push({ kind: 'sub', text: m[1] });
		} else if (line.trim() === '') {
			flush();
		} else {
			para.push(line);
		}
	}
	flush();
	return blocks;
}
