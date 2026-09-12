/** Read-only snapshot for source discovery and publication preservation checks.
 * Run with the intended environment; production access follows cs.md.
 * No credentials, source prose, or user data are emitted.
 */
import pg from 'pg';
import { createHash } from 'node:crypto';
const client = new pg.Client({ options: '-c default_transaction_read_only=on' });
await client.connect();
try {
  const rows = (await client.query(`SELECT e.family_code AS code,min(t.family) AS name,
    min(t.family_sci_name) AS "scientificName",min(t.order_name) AS "order",count(*)::int AS count,
    array_agg(t.sci_name ORDER BY t.sci_name) AS members,e.status,e.content,e.source,
    e.input_hash,e.published_hash,e.generated_at
    FROM family_enrichment e JOIN taxonomy_cache t ON t.family_code=e.family_code AND t.category='species'
    GROUP BY e.family_code ORDER BY e.family_code`)).rows;
  console.log(JSON.stringify({
    at: new Date(),
    targets: rows.filter(row => row.status !== 'ready').map(({ content, source, ...row }) => row),
    preserve: rows.filter(row => row.status === 'ready').map(row => ({
      code: row.code,
      input_hash: row.input_hash,
      fingerprint: createHash('sha256').update(JSON.stringify([row.content,row.source,row.published_hash,row.generated_at])).digest('hex'),
    })),
  }, null, 2));
} finally { await client.end(); }
