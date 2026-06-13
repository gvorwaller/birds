import { q as query } from "./db.js";
import { h as haversineKm } from "./geo.js";
import { a as recentNearbyObs, b as recentObs, n as notableObs } from "./ebird.js";
async function seenSet(userId) {
  const r = await query(
    "SELECT species_code FROM seen_species WHERE user_id = $1",
    [userId]
  );
  return new Set(r.rows.map((row) => row.species_code));
}
function aggregate(obs, home, photoCounts) {
  const bySpecies = /* @__PURE__ */ new Map();
  for (const o of obs) {
    if (!o.speciesCode) continue;
    let agg = bySpecies.get(o.speciesCode);
    if (!agg) {
      agg = {
        speciesCode: o.speciesCode,
        comName: o.comName,
        sciName: o.sciName,
        nReports: 0,
        totalCount: 0,
        lastObsDt: o.obsDt,
        locations: [],
        lastLat: o.lat,
        lastLng: o.lng,
        distanceKm: null,
        photoCount: photoCounts.get(o.speciesCode) ?? 0
      };
      bySpecies.set(o.speciesCode, agg);
    }
    agg.nReports++;
    agg.totalCount += o.howMany ?? 1;
    if (o.obsDt > agg.lastObsDt) {
      agg.lastObsDt = o.obsDt;
      agg.lastLat = o.lat;
      agg.lastLng = o.lng;
    }
    if (o.locName && !agg.locations.includes(o.locName) && agg.locations.length < 3) {
      agg.locations.push(o.locName);
    }
  }
  if (home) {
    for (const agg of bySpecies.values()) {
      agg.distanceKm = haversineKm(home.lat, home.lon, agg.lastLat, agg.lastLng);
    }
  }
  return bySpecies;
}
async function buildView(userId, recent, notable, home) {
  const seen = await seenSet(userId);
  const photoCounts = await (await import("./gallery.js").then((n) => n.c)).photoCountsBySpecies();
  const recentAgg = aggregate(recent.data, home, photoCounts);
  const needs = [...recentAgg.values()].filter((a) => !seen.has(a.speciesCode)).sort((a, b) => b.nReports - a.nReports || a.comName.localeCompare(b.comName));
  const notableAgg = aggregate(notable.data, home, photoCounts);
  const notableList = [...notableAgg.values()].map((a) => ({ ...a, seen: seen.has(a.speciesCode) })).sort((a, b) => b.lastObsDt.localeCompare(a.lastObsDt));
  return {
    needs,
    notable: notableList,
    stale: recent.stale || notable.stale,
    fetchedAt: recent.fetchedAt,
    seenCount: seen.size
  };
}
async function regionTargets(userId, apiKey, regionCode, back, home) {
  const [recent, notable] = await Promise.all([
    recentObs(apiKey, regionCode, back),
    notableObs(apiKey, regionCode, back)
  ]);
  return buildView(userId, recent, notable, home);
}
async function nearbyNeeds(userId, apiKey, home, distKm, back) {
  const recent = await recentNearbyObs(apiKey, home.lat, home.lon, distKm, back);
  const seen = await seenSet(userId);
  const photoCounts = await (await import("./gallery.js").then((n) => n.c)).photoCountsBySpecies();
  const agg = aggregate(recent.data, home, photoCounts);
  const needs = [...agg.values()].filter((a) => !seen.has(a.speciesCode)).sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
  return { needs, stale: recent.stale, fetchedAt: recent.fetchedAt };
}
export {
  nearbyNeeds as n,
  regionTargets as r
};
