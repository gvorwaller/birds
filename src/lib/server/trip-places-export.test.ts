import { describe, expect, it } from 'vitest';
import { normalizeTripPlaceRows } from './trip-places-export';

describe('normalizeTripPlaceRows', () => {
	it('exports only named located stops and preserves source fields', () => {
		const places = normalizeTripPlaceRows(
			[
				{
					stop_id: 10,
					birds_trip_id: 2,
					birds_trip_name: 'Coast run',
					birds_trip_start_date: '2026-07-04',
					birds_trip_end_date: null,
					sort_order: 1,
					hotspot_id: 'L123',
					custom_name: ' Harbor Point ',
					lat: 44.3,
					lon: -68.2,
					google_place_id: ' ChIJ123 ',
					notes: ' check tide ',
					field_tip: ' scope early ',
					field_tip_generated_at: '2026-07-04T12:00:00.000Z',
					target_count_at_save: 4
				},
				{
					stop_id: 11,
					birds_trip_id: 2,
					birds_trip_name: 'Coast run',
					birds_trip_start_date: '2026-07-04',
					birds_trip_end_date: null,
					sort_order: 2,
					hotspot_id: null,
					custom_name: 'No coords',
					lat: null,
					lon: null,
					google_place_id: null,
					notes: null,
					field_tip: null,
					field_tip_generated_at: null,
					target_count_at_save: null
				},
				{
					stop_id: 12,
					birds_trip_id: 2,
					birds_trip_name: 'Coast run',
					birds_trip_start_date: '2026-07-04',
					birds_trip_end_date: null,
					sort_order: 3,
					hotspot_id: null,
					custom_name: '  ',
					lat: 44.3,
					lon: -68.2,
					google_place_id: null,
					notes: null,
					field_tip: null,
					field_tip_generated_at: null,
					target_count_at_save: null
				}
			],
			{ includeFieldTips: true }
		);

		expect(places).toEqual([
			{
				source: 'birds',
				source_id: 'birds:trip_stop:10',
				birds_trip_id: 2,
				birds_trip_name: 'Coast run',
				birds_trip_start_date: '2026-07-04',
				birds_trip_end_date: null,
				stop_id: 10,
				sort_order: 1,
				name: 'Harbor Point',
				lat: 44.3,
				lon: -68.2,
				google_place_id: 'ChIJ123',
				hotspot_id: 'L123',
				notes: 'check tide',
				field_tip: 'scope early',
				field_tip_generated_at: '2026-07-04T12:00:00.000Z',
				target_count_at_save: 4
			}
		]);
	});

	it('omits field tips when disabled', () => {
		const places = normalizeTripPlaceRows(
			[
				{
					stop_id: 10,
					birds_trip_id: 2,
					birds_trip_name: 'Coast run',
					birds_trip_start_date: null,
					birds_trip_end_date: null,
					sort_order: 1,
					hotspot_id: null,
					custom_name: 'Harbor Point',
					lat: 44.3,
					lon: -68.2,
					google_place_id: null,
					notes: null,
					field_tip: 'scope early',
					field_tip_generated_at: '2026-07-04T12:00:00.000Z',
					target_count_at_save: null
				}
			],
			{ includeFieldTips: false }
		);

		expect(places[0]).toMatchObject({
			field_tip: null,
			field_tip_generated_at: null
		});
	});
});
