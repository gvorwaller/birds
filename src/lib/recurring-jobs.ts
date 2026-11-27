/**
 * System-recurring job types: self-rescheduling singletons owned by the
 * lowest-id admin, never cancellable. One list for the server (jobs.ts,
 * job-policy.ts) and the page that offers Cancel (td-9fe839, CODEX1 #9),
 * so a new recurring type can't be missed in one of them.
 */
export const RECURRING_JOB_TYPES: ReadonlySet<string> = new Set([
	'scan_need_alerts',
	'scan_enrichment',
	'enrich_families',
	'tag_consistency',
	'refresh_external_sources'
]);
