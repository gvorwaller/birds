import * as server from '../entries/pages/_layout.server.ts.js';

export const index = 0;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_layout.svelte.js')).default;
export { server };
export const server_id = "src/routes/+layout.server.ts";
export const imports = ["_app/immutable/nodes/0.CeBBN5Hf.js","_app/immutable/chunks/Bzak7iHL.js","_app/immutable/chunks/s5gLsJt6.js","_app/immutable/chunks/BcU-aBN0.js","_app/immutable/chunks/BLPMuAyN.js","_app/immutable/chunks/4EdvJpvX.js","_app/immutable/chunks/BX3Dks6W.js","_app/immutable/chunks/ZRluw53g.js","_app/immutable/chunks/Ctluk3GF.js","_app/immutable/chunks/D7_j7bj9.js"];
export const stylesheets = ["_app/immutable/assets/0.D6vwlyI7.css"];
export const fonts = [];
