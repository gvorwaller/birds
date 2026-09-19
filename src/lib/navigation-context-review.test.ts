import { describe, expect, it } from 'vitest';
import { canonicalHref, withReturnTo, parseLocalHref, createNavigationNode, parseNavigationSnapshot, navigationTrail, upsertNavigationNode, emptyNavigationSnapshot } from './navigation-context';

// Primary review regressions: observable navigation/data preservation boundaries.
describe('review: canonical content and safe immediate fallback', () => {
 it('drops a named POST action when constructing a normal return GET',()=>{
  expect(canonicalHref('/hotspots/L299291?/load_hotspot&tab=monthly&month=9&back=30')).toBe('/hotspots/L299291?tab=monthly&month=9&back=30');
 });

 it('keeps content query, fragment and explicit empty filters while removing only ancestry', () => {
  const href=canonicalHref('/hotspots/L299291?tab=monthly&month=9&back=30&q=&custom=x%26y&returnTo=%2Ftrips%2F9#monthly');
  const u=new URL(href!, 'https://birds.test');
  expect(u.pathname).toBe('/hotspots/L299291');
  expect([...u.searchParams]).toEqual([['tab','monthly'],['month','9'],['back','30'],['q',''],['custom','x&y']]);
  expect(u.hash).toBe('#monthly');
 });
 it('does not retarget a safe content URL to Home because a history budget is exceeded', () => {
  const query='bird'.repeat(2200);
  const destination='/species/comgra?custom='+query+'&back=30';
  const canonical=canonicalHref(destination);
  expect(canonical).not.toBeNull();
  const linked=new URL(withReturnTo(destination,'/trips/9'),'https://birds.test');
  expect(linked.pathname).toBe('/species/comgra');
  expect(linked.searchParams.get('custom')).toBe(query);
  expect(linked.searchParams.get('back')).toBe('30');
 });
 it('preserves provider/content URL text in query without treating it as a redirect', () => {
  expect(canonicalHref('/species?q=https%3A%2F%2Fexample.org%2Fbird&returnTo=%2Ftrips')).toBe('/species?q=https%3A%2F%2Fexample.org%2Fbird');
 });
 it('does not recursively wrap ancestry across twenty hops', () => {
  let source='/trips/9?returnTo=%2Ftrips';const lengths=[];
  for(let i=0;i<20;i++){
   const next=withReturnTo(i%2?'/species/comgra?back=30':'/hotspots/L299291?tab=monthly&month=9&back=30',source);
   const u=new URL(next,'https://birds.test');const parent=new URL(u.searchParams.get('returnTo')!,'https://birds.test');
   expect(parent.searchParams.has('returnTo')).toBe(false);
   lengths.push(next.length);source=next;
  }
  expect(Math.max(...lengths)).toBeLessThan(250);
 });
 for(const bad of ['//external.test/path','/\\external.test/path','/%5cexternal.test','/species/%0d%0aLocation:evil','/species/%ZZ','https://external.test']){
  it('rejects unsafe local destination '+JSON.stringify(bad),()=>expect(parseLocalHref(bad)).toBeNull());
 }
});

describe('review: expired ancestry is disclosed rather than fabricated',()=>{
 it('does not coerce missing or numeric storage IDs into valid opaque strings',()=>{
  const snapshot=parseNavigationSnapshot({version:1,nodes:[
   {href:'/trips/9',label:'Missing id'},
   {id:123456789,href:'/trips/9',label:'Numeric id'}
  ]});
  expect(snapshot.nodes).toEqual([]);
 });

 it('marks a validated node with an evicted parent as incomplete',()=>{
  const child=createNavigationNode({id:'child_1234',href:'/species/comgra',label:'Common Grackle',parentId:'parent_1234'})!;
  const snapshot=parseNavigationSnapshot({version:1,nodes:[child]});
  const trail=navigationTrail(snapshot,child.id);
  expect(trail.nodes.map(n=>n.label)).toEqual(['Common Grackle']);
  expect(trail.truncated).toBe(true);
 });
 it('evicts history without changing any remaining content query and detects the missing ancestor',()=>{
  let snapshot=emptyNavigationSnapshot();let parentId:string|null=null;
  for(let i=0;i<101;i++){
   const candidate=createNavigationNode({id:'node_'+String(i).padStart(8,'0'),href:'/species/comgra?custom='+i,label:'Common Grackle',parentId});
   if (!candidate) throw new Error('expected valid navigation node');
   const node=candidate;
   snapshot=upsertNavigationNode(snapshot,node);parentId=node.id;
  }
  expect(snapshot.nodes).toHaveLength(100);
  expect(snapshot.nodes[0].href).toBe('/species/comgra?custom=1');
  const restored=parseNavigationSnapshot(snapshot);
  const trail=navigationTrail(restored,parentId);
  expect(trail.nodes).toHaveLength(100);
  expect(trail.truncated).toBe(true);
 });
 it('stops cyclic history without repeating nodes',()=>{
  const a=createNavigationNode({id:'node_aaaa',href:'/trips/9',label:'Trip',parentId:'node_bbbb'})!;
  const b=createNavigationNode({id:'node_bbbb',href:'/hotspots/L299291',label:'Hotspot',parentId:a.id})!;
  const trail=navigationTrail(parseNavigationSnapshot({version:1,nodes:[a,b]}),b.id);
  expect(trail.truncated).toBe(true);expect(new Set(trail.nodes.map(n=>n.id)).size).toBe(trail.nodes.length);
 });
});
