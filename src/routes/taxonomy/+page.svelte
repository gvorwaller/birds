<script lang="ts">
  import FieldGuideTabs from '$components/FieldGuideTabs.svelte';
  import ViewedBadge from '$components/ViewedBadge.svelte';
  import { taxonomyHref } from '$lib/taxonomy';
  import { afterNavigate } from '$app/navigation';
  import type { PageData } from './$types';
  let {data}:{data:PageData}=$props();
  const note=$derived(data.enrichment.note);
  const described=$derived(data.enrichment.ready);
  function href(family?:string,order?:string) {
    const url=new URL(taxonomyHref(family,undefined,order),'https://birds.invalid');
    if(data.q)url.searchParams.set('q',data.q);
    return url.pathname+url.search;
  }
  function detailHref(code:string) {
    const p=new URL(data.returnTo,'https://birds.invalid');p.searchParams.set('focus',code);
    return `/species/${code}?returnTo=${encodeURIComponent(p.pathname+p.search)}`;
  }
  afterNavigate(()=>{ if(data.focus) document.getElementById('taxon-'+data.focus)?.scrollIntoView({block:'center'}); else if(data.family) document.getElementById('family-title')?.scrollIntoView({block:'start'}); });
</script>
<svelte:head><title>Taxonomy — birds</title></svelte:head>
<div class="page">
  <h1>📖 Field guide</h1>
  <p class="muted">Explore how birds are related, then follow a species to study it.</p>
  <FieldGuideTabs active="taxonomy" />
  <section class="card">
    <h2>Understanding bird taxonomy</h2>
    <p>Taxonomy names and groups birds by their relationships. This guide follows the eBird taxonomy, so its species names agree with the rest of Birds.</p>
    <details><summary>Orders, families, genera, and species</summary>
      <dl><dt>Order</dt><dd>A broad group containing related families, such as Accipitriformes, which includes several families of birds of prey.</dd>
      <dt>Family</dt><dd>A closer grouping of relatives. Pandionidae is the Osprey family. Scientific family names usually end in “-idae.”</dd>
      <dt>Genus</dt><dd>A grouping within a family. The first part of a scientific species name identifies its genus: <em>Pandion</em> in <em>Pandion haliaetus</em>.</dd>
      <dt>Species</dt><dd>The level used for the species lists in this app. A two-part scientific name identifies a species; common names are the familiar names used in a language.</dd></dl>
      <p>Taxonomic order places relatives together; it is not alphabetical order or a ranking of importance. This browser steps through orders, families, and species. Genus is explained here but is not a separate browsing level.</p>
    </details>
    <details><summary>Why names and classifications change</summary><p>New evidence can lead specialists to rearrange relationships, split one species into several, or combine species. Refreshing reference information does not automatically resolve which newly defined species an old observation represents.</p><p><a href="https://www.birds.cornell.edu/clementschecklist/introduction/updateindex/october-2025/" target="_blank" rel="noopener">Cornell: taxonomy changes and taxon concepts</a></p></details>
    <details><summary>Subspecies, hybrids, and uncertain identifications</summary><p>A species can contain subspecies and identifiable groups. eBird also accepts hybrid reports and uncertain identifications: a “slash” identifies alternatives, while a “spuh” reports a broader identification, such as an unidentified bird in a group. These reports are not additional species in this browser.</p><p>This reference does not convert these reports into confirmed sightings or change your life list.</p><a href="https://www.birds.cornell.edu/clementschecklist/about/methods/" target="_blank" rel="noopener">Cornell: classification methods</a></details>
  </section>
  <section class="card">
    <h2>Browse taxonomy</h2>
    <form action="/taxonomy" method="GET"><label for="taxonomy-search">Search orders, families, or species</label><div class="search"><input id="taxonomy-search" name="q" type="search" value={data.q} placeholder="Name, species or banding code" /><button>Search</button>{#if data.q}<a href="/taxonomy">Clear</a>{/if}</div></form>
    <p class="muted">{data.summary.total} current species. Counts include only species, not other reporting categories. Family notes: {described} of {data.summary.families.length} families.</p>
    {#if data.summary.refreshed}<p class="muted">Taxonomy refreshed {new Date(data.summary.refreshed).toLocaleDateString()}.</p>{/if}
    {#if !data.summary.ordered}<p role="status">Classification and taxonomic ordering await a taxonomy refresh. Species remain available below and in Browse species.</p>{/if}
    {#if data.viewedUnavailable}<p role="status">Your viewing history is temporarily unavailable.</p>{/if}
    {#if data.unavailableOrder}<p role="status">This order is no longer available in the loaded taxonomy. <a href="/taxonomy">Return to the overview</a>.</p>{/if}
    {#if data.unavailableFamily}<p role="status">This family is no longer available in the loaded taxonomy. <a href="/taxonomy">Return to the overview</a>.</p>{/if}
    {#if !data.groups.length && !data.missingMatches}<p>No matching orders, families, or species.</p>{/if}
    {#each data.groups as group}
      {@const expanded=data.order===group.name || (group.name==='Classification unavailable' && !!data.selected && !data.selected.order)}
      <div class="order"><a class="disclosure" aria-expanded={expanded} href={expanded ? href() : href(undefined,group.name)}><span aria-hidden="true">{expanded?'▾':'▸'}</span><strong>{group.name}</strong><span class="muted">{group.count} species</span></a>
        {#if expanded}<ul class="families">{#each group.families as family}<li><a class="disclosure" aria-expanded={data.family===family.code} href={data.family===family.code ? href(undefined,group.name) : href(family.code,group.name)}><span aria-hidden="true">{data.family===family.code?'▾':'▸'}</span><strong>{family.name ?? family.scientificName ?? family.code}</strong>{#if family.scientificName}<em>{family.scientificName}</em>{/if}<span class="muted">{family.count} species{data.q ? ` · ${family.matching} matching` : ''}</span></a></li>{/each}</ul>{/if}
      </div>
    {/each}
    {#if data.missingMatches}<a class="disclosure" href={href('unclassified')}>Classification unavailable · {data.missingMatches} species</a>{/if}
  </section>
  {#if data.family && !data.unavailableFamily}
    <section class="card" aria-labelledby="family-title">
      <h2 id="family-title">{data.selected?.name ?? data.selected?.scientificName ?? 'Classification unavailable'}</h2>
      {#if data.selected?.scientificName}<p><em>{data.selected.scientificName}</em>{data.selected.order ? ` · ${data.selected.order}` : ''}</p>{/if}
      {#if note?.content && note.source}
        {#each note.content.paragraphs as paragraph}
          <h3>{paragraph.topic}</h3><p>{paragraph.text}</p>
        {/each}
        <p class="muted">AI summary, automatically checked against the source; not human-reviewed.
          {#each note.sources as source}
            Adapted from <a href={source.url} target="_blank" rel="noopener">{source.attribution}: {source.title}</a>,
            <a href={source.licenseUrl} target="_blank" rel="noopener">{source.license}</a>.
          {/each}
          Generated {note.generatedAt ? new Date(note.generatedAt).toLocaleDateString() : ''}.
        </p>
        {#if note.stale}<p class="muted">Showing the previous description while an updated version is pending.</p>{/if}
      {:else if note?.status === 'no_source'}
        <p class="muted">No suitable family source was found yet. The background process will check again; the species list remains available below.</p>
      {:else if note?.status === 'error'}
        <p class="muted">This description could not be completed yet. An automatic retry is scheduled.</p>
      {:else}
        <p class="muted">This family description is awaiting automatic enrichment{data.enrichment.paused ? ' (currently paused)' : ''}. The species list is available below.</p>
      {/if}
      {#if data.selected}<a class="family-browse" href={'/species?family='+encodeURIComponent(data.selected.code)}>Browse this family with Field Guide filters →</a>{/if}
      <p>{data.rows.length} species{data.q ? ' matching your search' : ''}. Ordered taxonomically where available.</p>
      {#if data.focusUnavailable}<p role="status">The linked species is not in this family’s current results. <a href={taxonomyHref(data.family)}>Show this family without search filters</a>.</p>{/if}
      <ul class="species">{#each data.rows as row}<li id={'taxon-'+row.code} class:focused={data.focus===row.code}>{#if data.focus===row.code}<strong class="focus-label">Selected species</strong>{/if}<div class="name"><a href={detailHref(row.code)}>{row.name}</a>{#if data.viewed[row.code]}<ViewedBadge view={data.viewed[row.code]} />{/if}{#if row.extinct===true}<span>Extinct</span>{/if}</div><em>{row.scientificName}</em>{#if row.matchedBandingCode}<p class="muted">Banding code: {row.matchedBandingCode}</p>{/if}</li>{/each}</ul>
    </section>
  {/if}
  <p class="muted"><a href="https://ebird.org" target="_blank" rel="noopener">Data from eBird.org</a>. Classification reference: <a href="https://www.birds.cornell.edu/clementschecklist/" target="_blank" rel="noopener">Cornell’s eBird/Clements checklist</a>.</p>
</div>
<style>
  #family-title { scroll-margin-top: 90px; }
  .page{max-width:960px;margin:0 auto;padding:16px}h1{font-size:1.4rem;margin-bottom:8px}h2{font-size:1.15rem;margin-bottom:12px}.page>p{margin:12px 0}.card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px;margin:16px 0}.card p{margin:12px 0}.muted{color:var(--muted);font-size:.9rem}summary,.disclosure,.family-browse{min-height:48px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0}summary{display:list-item;cursor:pointer;font-weight:600}details,.order{border-top:1px solid var(--border)}dt{font-weight:700;margin-top:12px}dd{margin:4px 0 12px}.search{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:8px 0}input{flex:1;min-width:0;width:100%;min-height:48px;font-size:1rem;background:var(--bg);color:var(--text);padding:10px;border:1px solid var(--border);border-radius:6px}button{min-height:48px;padding:10px 16px;font-size:1rem;background:var(--accent);color:var(--on-accent);border:0;border-radius:6px}.families{list-style:none;padding-left:16px}.disclosure{text-decoration:none}.disclosure:hover{text-decoration:underline}.species{list-style:none;padding:0}.species li{padding:12px 8px;border-top:1px solid var(--border);scroll-margin-top:90px;overflow-wrap:anywhere}.name{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.name a{min-height:48px;display:inline-flex;align-items:center;font-weight:700}.focused{border:2px solid var(--accent);border-radius:6px}.focus-label{display:block;font-size:.85rem}.card a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.search a{min-height:48px;display:inline-flex;align-items:center}
</style>
