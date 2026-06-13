import * as server from '../entries/pages/settings/_page.server.ts.js';

export const index = 5;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/settings/_page.svelte.js')).default;
export { server };
export const server_id = "src/routes/settings/+page.server.ts";
export const imports = ["_app/immutable/nodes/5.DYKP1gSj.js","_app/immutable/chunks/Bzak7iHL.js","_app/immutable/chunks/s5gLsJt6.js","_app/immutable/chunks/4EdvJpvX.js","_app/immutable/chunks/BX3Dks6W.js","_app/immutable/chunks/ZRluw53g.js","_app/immutable/chunks/DCiy7Xor.js","_app/immutable/chunks/BjykHyxi.js","_app/immutable/chunks/D7_j7bj9.js","_app/immutable/chunks/BLPMuAyN.js","_app/immutable/chunks/Ctluk3GF.js","_app/immutable/chunks/D2Q_iKJ-.js"];
export const stylesheets = ["_app/immutable/assets/Badge.Cz9B1HVB.css","_app/immutable/assets/5.CTV2MZtY.css"];
export const fonts = [];
