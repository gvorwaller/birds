import {describe,it,expect} from 'vitest';
import {safeReturnTo,returnTrail} from './return-link';
import {withReturnTo} from './navigation-context';
describe('review: all ordinary return URLs use the same trust boundary',()=>{
 for(const target of ['/\\external.test/path','/%5cexternal.test/path','/species/%0d%0aLocation:bad','/species/%ZZ','//external.test/path']) {
  it('rejects an unsafe legacy query target '+JSON.stringify(target),()=>{
   expect(safeReturnTo(target).href).toBe('/');
   expect(returnTrail('/species/comgra?returnTo='+encodeURIComponent(target)).every(crumb=>crumb.href!==target)).toBe(true);
  });
 }
 it('retains unknown content, empty criteria and named immediate source without recursive labels',()=>{
  const href=withReturnTo('/species/comgra?custom=one&criteria=', '/hotspots/L299291?month=9&returnTo=%2Ftrips%2F9&returnLabel=Trip',undefined,'Myakka River SP');
  const result=new URL(href,'https://birds.test');
  expect(result.searchParams.get('returnLabel')).toBe('Myakka River SP');
  expect(result.searchParams.get('returnTo')).toBe('/hotspots/L299291?month=9');
  expect(result.searchParams.get('custom')).toBe('one');expect(result.searchParams.has('criteria')).toBe(true);
 });
});
