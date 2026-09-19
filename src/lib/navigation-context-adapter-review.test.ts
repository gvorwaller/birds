import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const fixture=vi.hoisted(()=>({page:{url:new URL('https://birds.test/trips/9'),state:{} as Record<string,unknown>},goto:vi.fn(),replaceState:vi.fn()}));
vi.mock('$app/environment',()=>({browser:true}));
vi.mock('$app/state',()=>({page:fixture.page}));
vi.mock('$app/navigation',()=>({goto:fixture.goto,replaceState:fixture.replaceState}));
const store=new Map<string,string>();
function event(){return {button:0,metaKey:false,ctrlKey:false,shiftKey:false,altKey:false,defaultPrevented:false,currentTarget:{target:'',hasAttribute:()=>false},preventDefault:vi.fn()} as unknown as MouseEvent}
async function loadAdapter(){return import('./navigation-context.svelte')}
beforeEach(()=>{
 vi.resetModules();store.clear();fixture.page.url=new URL('https://birds.test/trips/9');fixture.page.state={unrelated:'preserved'};
 vi.stubGlobal('window',{sessionStorage:{get length(){return store.size},key:(index:number)=>[...store.keys()][index]??null,getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>store.set(k,v),removeItem:(k:string)=>store.delete(k)},location:{origin:'https://birds.test'},scrollY:120});
 vi.stubGlobal('document',{activeElement:null});
 fixture.replaceState.mockReset().mockImplementation((_url:unknown,state:Record<string,unknown>)=>{fixture.page.state=state});
 fixture.goto.mockReset().mockImplementation(async (href:string,options:{state:Record<string,unknown>})=>{fixture.page.url=new URL(href,'https://birds.test');fixture.page.state=options.state});
});
afterEach(()=>vi.unstubAllGlobals());
describe('review: public history adapter behavior',()=>{
 it('clears account history on a fresh logged-out document with no in-memory account',async()=>{
  let nav=await loadAdapter();nav.ensureCurrentNode({accountId:1,label:'Private trip'});nav.navigationAfterNavigate(1);
  store.set('unrelated-setting','keep');vi.resetModules();fixture.page.url=new URL('https://birds.test/login');fixture.page.state={};
  nav=await loadAdapter();nav.navigationAfterNavigate(null,'enter');
  expect([...store.keys()]).toEqual(['unrelated-setting']);
 });

 it('refreshes the reload bridge after native Back without overwriting the referenced node',async()=>{
  let nav=await loadAdapter();const trip=nav.ensureCurrentNode({accountId:1,label:'Trip'})!;
  nav.navigateWithContext({event:event(),href:'/hotspots/L299291?returnTo=%2Ftrips%2F9',label:'Myakka River SP',accountId:1});await Promise.resolve();await Promise.resolve();
  fixture.page.url=new URL('https://birds.test/trips/9');fixture.page.state={birdsNavigation:{accountId:1,nodeId:trip.id}};nav.navigationAfterNavigate(1,'popstate');
  expect(nav.shouldRestoreNavigationOrigin()).toBe(false);
  expect(nav.trailFor(1).nodes.map(n=>n.label)).toEqual(['Trip']);
  vi.resetModules();fixture.page.state={};vi.stubGlobal('performance',{getEntriesByType:()=>[{type:'reload'}]});
  nav=await loadAdapter();const reloaded=nav.ensureCurrentNode({accountId:1,label:'Trip'})!;
  expect(reloaded.id).toBe(trip.id);
 });

 for(const kind of ['reload','navigate']) it('restores a tab bridge only for actual '+kind+' document entry',async()=>{
  let nav=await loadAdapter();nav.ensureCurrentNode({accountId:1,label:'Trip'});
  nav.navigateWithContext({event:event(),href:'/hotspots/L299291?returnTo=%2Ftrips%2F9',label:'Myakka River SP',accountId:1});await Promise.resolve();await Promise.resolve();
  vi.resetModules();fixture.page.state={};const perf={getEntriesByType:()=>[{type:kind}]};vi.stubGlobal('performance',perf);Object.assign(window,{performance:perf});
  nav=await loadAdapter();nav.ensureCurrentNode({accountId:1,label:'Myakka River SP'});nav.navigationAfterNavigate(1);
  expect(nav.trailFor(1).nodes.map(n=>n.label)).toEqual(kind==='reload'?['Trip','Myakka River SP']:['Myakka River SP']);
 });

 it('does not revive a stale journey after an ordinary primary-navigation detour',async()=>{
  const nav=await loadAdapter();nav.ensureCurrentNode({accountId:1,label:'Trip'});
  nav.navigateWithContext({event:event(),href:'/hotspots/L299291?returnTo=%2Ftrips%2F9',label:'Myakka River SP',accountId:1});await Promise.resolve();await Promise.resolve();
  fixture.page.url=new URL('https://birds.test/help');fixture.page.state={};nav.navigationAfterNavigate(1);
  fixture.page.url=new URL('https://birds.test/hotspots/L299291');fixture.page.state={};
  nav.ensureCurrentNode({accountId:1,label:'Myakka River SP'});
  expect(nav.trailFor(1).nodes.map(n=>n.label)).toEqual(['Myakka River SP']);
 });

 it('attaches the existing hotspot reference to a native tab-change history entry for refresh',async()=>{
  const nav=await loadAdapter();nav.ensureCurrentNode({accountId:1,label:'Trip'});
  nav.navigateWithContext({event:event(),href:'/hotspots/L299291?returnTo=%2Ftrips%2F9',label:'Myakka River SP',accountId:1});await Promise.resolve();await Promise.resolve();
  const previous=fixture.page.state.birdsNavigation;
  fixture.page.url=new URL('https://birds.test/hotspots/L299291?tab=monthly&month=9&returnTo=%2Ftrips%2F9');fixture.page.state={custom:'keep'};
  nav.ensureCurrentNode({accountId:1,label:'Myakka River SP'});
  expect(fixture.page.state.birdsNavigation).toEqual(previous);expect(fixture.page.state.custom).toBe('keep');
 });

 it('does not reuse a hotspot node from an unrelated earlier trip journey',async()=>{
  const nav=await loadAdapter();nav.ensureCurrentNode({accountId:1,label:'First trip'});
  nav.navigateWithContext({event:event(),href:'/hotspots/L299291?returnTo=%2Ftrips%2F9',label:'Myakka River SP',accountId:1});await Promise.resolve();await Promise.resolve();
  fixture.page.url=new URL('https://birds.test/trips/10');fixture.page.state={};nav.ensureCurrentNode({accountId:1,label:'Second trip'});
  nav.navigateWithContext({event:event(),href:'/hotspots/L299291?returnTo=%2Ftrips%2F10',label:'Myakka River SP',accountId:1});await Promise.resolve();await Promise.resolve();
  expect(nav.trailFor(1).nodes.map(n=>n.label)).toEqual(['Second trip','Myakka River SP']);
 });

 it('handles a direct safe URL larger than metadata limits without crashing',async()=>{
  const nav=await loadAdapter();fixture.page.url=new URL('https://birds.test/species/comgra?criteria='+'bird'.repeat(2200));
  expect(()=>nav.ensureCurrentNode({accountId:1,label:'Common Grackle'})).not.toThrow();
  expect(fixture.page.url.searchParams.get('criteria')).toBe('bird'.repeat(2200));
 });
 it('clears private path state on signout even with no pending navigation',async()=>{
  const nav=await loadAdapter();nav.ensureCurrentNode({accountId:1,label:'Private owner trip'});
  expect([...store.values()].join('')).toContain('Private owner trip');
  fixture.page.url=new URL('https://birds.test/login');nav.navigationAfterNavigate(null);
  expect([...store.values()].join('')).not.toContain('Private owner trip');
 });
 it('does not rewrite a different resource into the prior current node',async()=>{
  const nav=await loadAdapter();const first=nav.ensureCurrentNode({accountId:1,label:'Myakka trip'})!;
  fixture.page.url=new URL('https://birds.test/species/comgra');fixture.page.state={};
  const second=nav.updateCurrentNode({accountId:1,href:'/species/comgra',label:'Common Grackle'});
  expect(second?.id).not.toBe(first.id);
  expect([...store.values()].join('')).toContain('/trips/9');
 });

 it('leaves an oversized but safe destination usable instead of swallowing the click',async()=>{
  const nav=await loadAdapter();nav.ensureCurrentNode({accountId:1,label:'Myakka trip'});
  const click=event();const href='/species/comgra?custom='+'bird'.repeat(2200);
  expect(()=>nav.navigateWithContext({event:click,href,label:'Common Grackle',accountId:1})).not.toThrow();
  await Promise.resolve();await Promise.resolve();
  if(fixture.goto.mock.calls.length)expect(new URL(fixture.goto.mock.calls[0][0],'https://birds.test').searchParams.get('custom')).toBe('bird'.repeat(2200));
  else expect(click.preventDefault).not.toHaveBeenCalled();
 });

 it('clears the departing account and rejects its stale page reference for another account',async()=>{
  const nav=await loadAdapter();nav.ensureCurrentNode({accountId:1,label:'Owner trip'});
  expect([...store.values()].join('')).toContain('Owner trip');
  nav.clearNavigationAccount(1);
  nav.ensureCurrentNode({accountId:2,label:'Viewer page'});
  expect([...store.values()].join('')).not.toContain('Owner trip');
  expect(nav.trailFor(2).nodes.map(n=>n.label)).toEqual(['Viewer page']);
 });

 it('keeps a usable immediate fallback in the real navigated URL and merges history state',async()=>{
  const nav=await loadAdapter();nav.ensureCurrentNode({accountId:1,label:'Myakka trip'});
  nav.navigateWithContext({event:event(),href:'/hotspots/L299291?tab=monthly&month=9&returnTo=%2Ftrips%2F9',label:'Myakka River SP',accountId:1,originId:'stop-27'});
  await Promise.resolve();await Promise.resolve();
  expect(fixture.page.url.searchParams.get('returnTo')).toBe('/trips/9');expect(fixture.page.state.unrelated).toBe('preserved');
  expect(nav.trailFor(1).nodes.map(n=>n.label)).toEqual(['Myakka trip','Myakka River SP']);
 });
 it('updates month on the same hotspot without losing its trip parent or creating another node',async()=>{
  const nav=await loadAdapter();nav.ensureCurrentNode({accountId:1,label:'Myakka trip'});
  nav.navigateWithContext({event:event(),href:'/hotspots/L299291?tab=monthly&month=9&returnTo=%2Ftrips%2F9',label:'Myakka River SP',accountId:1});await Promise.resolve();await Promise.resolve();
  const before=nav.trailFor(1).nodes.at(-1)!.id;
  fixture.page.url=new URL('https://birds.test/hotspots/L299291?tab=monthly&month=10&returnTo=%2Ftrips%2F9');
  nav.updateCurrentNode({accountId:1,href:fixture.page.url.pathname+fixture.page.url.search,label:'Myakka River SP',ui:{expanded:true}});
  const trail=nav.trailFor(1).nodes;expect(trail.map(n=>n.label)).toEqual(['Myakka trip','Myakka River SP']);expect(trail.at(-1)!.id).toBe(before);expect(trail.at(-1)!.href).toContain('month=10');
 });
 it('records the departure row on the source, not the destination',async()=>{
  const nav=await loadAdapter();nav.ensureCurrentNode({accountId:1,label:'Myakka trip'});
  nav.navigateWithContext({event:event(),href:'/hotspots/L299291?returnTo=%2Ftrips%2F9',label:'Myakka River SP',accountId:1,originId:'stop-27'});await Promise.resolve();await Promise.resolve();
  const trail=nav.trailFor(1).nodes;expect(trail[0].originId).toBe('stop-27');expect(trail[1].originId).not.toBe('stop-27');
 });
 it('does not install a resolved old navigation over a newer ordinary route',async()=>{
  const nav=await loadAdapter();nav.ensureCurrentNode({accountId:1,label:'Myakka trip'});let finish!:()=>void;
  fixture.goto.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve}));
  nav.navigateWithContext({event:event(),href:'/hotspots/L299291?returnTo=%2Ftrips%2F9',label:'Myakka River SP',accountId:1});
  fixture.page.url=new URL('https://birds.test/help');fixture.page.state={unrelated:'winner'};finish();await Promise.resolve();await Promise.resolve();
  expect(fixture.page.state).toEqual({unrelated:'winner'});
 });
 it('reuses an existing resource node on a repeated hotspot visit',async()=>{
  const nav=await loadAdapter();nav.ensureCurrentNode({accountId:1,label:'Myakka trip'});
  nav.navigateWithContext({event:event(),href:'/hotspots/L299291?returnTo=%2Ftrips%2F9',label:'Myakka River SP',accountId:1});await Promise.resolve();await Promise.resolve();
  nav.navigateWithContext({event:event(),href:'/species/comgra?back=30&returnTo=%2Fhotspots%2FL299291',label:'Common Grackle',accountId:1});await Promise.resolve();await Promise.resolve();
  nav.navigateWithContext({event:event(),href:'/hotspots/L299291?tab=monthly&month=9&returnTo=%2Fspecies%2Fcomgra',label:'Myakka River SP',accountId:1});await Promise.resolve();await Promise.resolve();
  const trail=nav.trailFor(1).nodes;
  expect(trail.map(n=>n.label)).toEqual(['Myakka trip','Myakka River SP']);
  expect(trail.at(-1)?.href).toContain('tab=monthly');
 });
});
