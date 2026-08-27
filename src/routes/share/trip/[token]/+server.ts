import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { env } from "$env/dynamic/private";
import { getEbirdApiKey } from "$server/ebird";
import { getStops, needsCountForStops } from "$server/trips";
import { tripForToken } from "$server/trip-shares";
import { buildTripHtml, type TripExportData } from "$server/trip-export";

/**
 * Public trip field sheet (td-8b959f follow-up). NO session here — the URL
 * token is the whole credential (hooks lists /share/ as a public prefix);
 * tripForToken swaps it for the trip or nothing. All data reads run as the
 * trip OWNER (trip.user_id), because there is no viewer identity: the needs
 * shown are the owner's targets, and the builder's 'shared' mode labels them
 * that way and strips every link that would need a login.
 */
export const GET: RequestHandler = async ({ params, url }) => {
  const token = params.token;
  // Real tokens are 43 chars of base64url; anything oversized or empty is
  // noise not worth a DB round-trip.
  if (!token || token.length > 64 || !/^[A-Za-z0-9_-]+$/.test(token))
    throw error(404, "Not found");

  const trip = await tripForToken(token);
  if (!trip) throw error(404, "Not found");

  const owner = trip.user_id;
  const stops = await getStops(trip.id);
  const apiKey = await getEbirdApiKey(owner);
  const { counts, species } = await needsCountForStops(owner, apiKey, stops);

  const data: TripExportData = {
    trip,
    stops,
    counts,
    species,
    origin: url.origin || (env.BIRDS_PUBLIC_ORIGIN ?? "https://birds.gaylon.photos"),
    mode: "shared",
  };

  return new Response(buildTripHtml(data), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // The token is in the URL: never cache, never index, never leak it in
      // a Referer on the page's outbound eBird/Google links.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
};
