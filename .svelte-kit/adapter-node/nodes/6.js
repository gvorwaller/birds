import * as server from '../entries/pages/species/_code_/_page.server.ts.js';

export const index = 6;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/species/_code_/_page.svelte.js')).default;
export { server };
export const server_id = "src/routes/species/[code]/+page.server.ts";
export const imports = ["_app/immutable/nodes/6.fyyM3via.js","_app/immutable/chunks/Bzak7iHL.js","_app/immutable/chunks/s5gLsJt6.js","_app/immutable/chunks/4EdvJpvX.js","_app/immutable/chunks/BX3Dks6W.js","_app/immutable/chunks/ZRluw53g.js","_app/immutable/chunks/DCiy7Xor.js","_app/immutable/chunks/Ctluk3GF.js","_app/immutable/chunks/D2Q_iKJ-.js","_app/immutable/chunks/CXwEO2Fm.js"];
export const stylesheets = ["_app/immutable/assets/Badge.Cz9B1HVB.css","_app/immutable/assets/6.BK1qPVyu.css"];
export const fonts = [];
