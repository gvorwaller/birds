import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { env } from "$env/dynamic/private";
import { getEbirdApiKey } from "$server/ebird";
import { getStops, getTrip, needsCountForStops } from "$server/trips";
import {
  buildTripHtml,
  buildTripMarkdown,
  tripExportFilename,
  type TripExportData,
} from "$server/trip-export";

/**
 * Trip export (td-8b959f). GET ?format=html|md — html (the default) renders
 * INLINE so the link opens a self-contained, savable field sheet in a browser
 * tab; md keeps the original download behavior. What an export CONTAINS is
 * the builder module's business ($server/trip-export), not the route's.
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
  const userId = locals.scopeId!; // the data owner this account reads
  const tripId = Number(params.id);
  if (!Number.isInteger(tripId) || tripId <= 0)
    throw error(404, "Trip not found");

  const trip = await getTrip(userId, tripId);
  if (!trip) throw error(404, "Trip not found");

  const format = url.searchParams.get("format") ?? "html";
  if (format !== "html" && format !== "md")
    throw error(400, "Unknown format. Use html or md.");

  const stops = await getStops(tripId);
  const apiKey = await getEbirdApiKey(userId);
  const { counts, species } = await needsCountForStops(userId, apiKey, stops);

  const data: TripExportData = {
    trip,
    stops,
    counts,
    species,
    // url.origin is right in every real request (localhost included); the env
    // fallback exists for hand-built events (job-handlers.ts precedent).
    origin: url.origin || (env.BIRDS_PUBLIC_ORIGIN ?? "https://birds.gaylon.photos"),
  };

  // A trip's notes, coordinates and needs behind a cookie — private either way.
  const base = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };

  if (format === "md") {
    return new Response(buildTripMarkdown(data), {
      headers: {
        ...base,
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${tripExportFilename(trip.name)}"`,
      },
    });
  }
  return new Response(buildTripHtml(data), {
    headers: { ...base, "Content-Type": "text/html; charset=utf-8" },
  });
};
