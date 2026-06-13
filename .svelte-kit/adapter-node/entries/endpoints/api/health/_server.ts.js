import { json } from "@sveltejs/kit";
import { d as dbHealthCheck } from "../../../../chunks/db.js";
import { g as galleryHealth } from "../../../../chunks/gallery.js";
const VERSION = process.env.GIT_SHA ?? "dev";
const GET = async () => {
  const [dbOk, gallerySource] = await Promise.all([dbHealthCheck(), galleryHealth()]);
  const db = dbOk ? "ok" : "error";
  const status = db === "ok" ? 200 : 503;
  return json({ db, gallery_source: gallerySource, version: VERSION }, { status });
};
export {
  GET
};
