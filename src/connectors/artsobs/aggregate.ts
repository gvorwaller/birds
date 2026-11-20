/**
 * Norway's county aggregate: the shared one (td-99eebf) with Norway's county
 * names, "Artskart" in its notes and the runtime's default collation, exactly
 * as its loads were built before the move (parity.test.ts).
 */
import { REGION_NAMES } from './config';
import { CountyAggregate as SharedAggregate, type RecordSink, type Window } from '../shared/aggregate';

export { addDays, distanceM, partyText, placeLocality, type RecordSink, type RegionPayload, type Window } from '../shared/aggregate';

export class CountyAggregate extends SharedAggregate {
	constructor(regionCode: string, window: Window, sink: RecordSink | null = null) {
		const name = REGION_NAMES[regionCode];
		if (!name) throw new Error(`No Norwegian county ${regionCode}`);
		super(regionCode, name, window, sink, { sourceLabel: 'Artskart' });
	}
}
