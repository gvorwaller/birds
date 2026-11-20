/** Date helpers shared by every connector (td-99eebf; moved unchanged). */

export function addDays(iso: string, days: number): string {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** Calendar months from `start` through `through`, the last one clipped. */
export function monthRanges(start: string, through: string): [string, string][] {
	const out: [string, string][] = [];
	let y = Number(start.slice(0, 4));
	let m = Number(start.slice(5, 7));
	for (;;) {
		const first = `${y}-${String(m).padStart(2, '0')}-01`;
		if (first > through) break;
		const last = addDays(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`, -1);
		out.push([first < start ? start : first, last > through ? through : last]);
		if (++m > 12) {
			m = 1;
			y++;
		}
	}
	return out;
}
