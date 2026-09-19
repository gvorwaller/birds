export interface ClientJobPresentation {
	state?: string;
	explanation?: string;
	nextEligibleAt?: string;
}

export interface ClientJobProgress {
	unitsTotal?: number;
	unitsDone?: number;
	currentUnit?: { name?: string };
}

function timeLabel(iso: string | undefined): string | null {
	if (!iso) return null;
	const date = new Date(iso);
	return Number.isFinite(date.getTime())
		? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
		: null;
}

/** One honest, client-safe sentence for every API presentation state. */
export function jobPresentationText(
	presentation: ClientJobPresentation | null | undefined,
	progress: ClientJobProgress = {}
): string {
	const state = presentation?.state;
	const explanation = presentation?.explanation;
	const at = timeLabel(presentation?.nextEligibleAt);
	const when = at ? ` at ${at}` : '; time not available';
	if (state === 'running') {
		const total = progress.unitsTotal ?? 0;
		if (total > 0) {
			return `Running — ${progress.unitsDone ?? 0} of ${total}${progress.currentUnit?.name ? ` · ${progress.currentUnit.name}` : ''}${explanation ? ` — ${explanation}` : ''}`;
		}
		return explanation ? `Running — ${explanation}` : 'Running — progress not yet reported';
	}
	if (state === 'cancelling') return explanation ? `Cancelling — ${explanation}` : 'Cancelling';
	if (state === 'paused') return explanation ? `Paused — ${explanation}` : 'Paused';
	if (state === 'retry-scheduled') return `Retry scheduled${when}${explanation ? ` — ${explanation}` : ''}`;
	if (state === 'scheduled') return `Scheduled${when}${explanation ? ` — ${explanation}` : ''}`;
	if (state === 'waiting') return explanation ? `Waiting${when} — ${explanation}` : `Waiting${when}`;
	if (state === 'waiting-worker') return explanation ? `Waiting for worker — ${explanation}` : 'Waiting for worker';
	if (state === 'queued') return explanation ? `Queued — ${explanation}` : 'Queued';
	if (state === 'complete') return 'Complete';
	if (state === 'failed') return explanation ? `Failed — ${explanation}` : 'Failed';
	if (state === 'cancelled') return 'Cancelled';
	return 'Status unavailable';
}
