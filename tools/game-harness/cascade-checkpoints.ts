import type { NativeState } from "./protocol.ts";
import type { ReplayCheckpoint } from "./replay-observer.ts";

export type LunaGameData = { available: boolean; world: number; moons: number; acquired: number[];
  homeRestored?: boolean; worldMapNerve?: string; worldMapStep?: number };
export const lunaGameData = (state: NativeState) => (state as NativeState & { lunaGameData?: LunaGameData }).lunaGameData;
const has = (s: NativeState, id: number) => lunaGameData(s)?.available === true && lunaGameData(s)!.acquired.includes(id);
const playing = (s: NativeState) => /StageSceneNrvPlayE/.test(s.timing?.scene ?? "") && s.route?.player?.inputDisabled === false;
const upwards = (s: NativeState) => playing(s) && (s.route?.player?.velocity[1] ?? 0) > 3;

/** Read original GameDataFile state, rather than an edited HUD/count. */
export function verifyCascadePrerequisites(state: NativeState) {
  const data = lunaGameData(state);
  if (state.route?.stage !== "WaterfallWorldHomeStage" || !playing(state) || !data?.available || data.world !== 1 ||
      data.moons !== 3 || ![216, 206, 212].every(id => data.acquired.includes(id)) || [205, 207, 218].some(id => data.acquired.includes(id)))
    throw new Error("Cascade requires playable Waterfall with exactly the chest (216), Chomp rocks (206), and 2D (212) moons; story 205, painting 207 and boss 218 must be uncollected. Native state: " + JSON.stringify(data));
  return data;
}

/** Windows refer to the source tape; each check is passive and never steers. */
export function cascadeCheckpoints(frames: number): ReplayCheckpoint[] {
  const noBoss = (s: NativeState) => has(s, 218) ? "The source route must not acquire the boss multi-moon" : undefined;
  return [
    { label: "Collect the original first story moon / 3 to 4", from: 1, through: 1097, reject: noBoss,
      accept: s => has(s, 205) && lunaGameData(s)?.moons === 4 },
    { label: "Finish the recorded first-moon cutscene and dialogue", from: 1098, through: 1365,
      accept: s => playing(s) && has(s, 205) },
    { label: "Perform the first recorded movement jump", from: 1365, through: 1395, accept: upwards },
    { label: "Roll along the recorded route", from: 1400, through: 1698,
      accept: s => playing(s) && /NrvRoll/.test(s.timing?.playerNerve ?? "") && Math.hypot(s.route?.player?.velocity[0] ?? 0, s.route?.player?.velocity[2] ?? 0) > 15 },
    { label: "Perform the recorded roll cancel and cap throw", from: 1699, through: 1709,
      accept: s => playing(s) && /NrvSpinCapE/.test(s.timing?.playerNerve ?? "") && Math.hypot(s.route?.player?.velocity[0] ?? 0, s.route?.player?.velocity[2] ?? 0) > 15 },
    { label: "Warp to the original painting-island checkpoint", from: 1805, through: 2143,
      accept: s => playing(s) && (s.timing?.position?.[1] ?? 0) > 8400 && Math.hypot((s.timing?.position?.[0] ?? 0)-5020, (s.timing?.position?.[2] ?? 0)-10394) < 1500 },
    { label: "Perform the recorded jump after the map transition", from: 2163, through: 2195, accept: upwards },
    { label: "Collect the painting-island moon / 4 to 5", from: 2100, through: 2900, reject: noBoss,
      accept: s => has(s, 207) && lunaGameData(s)?.moons === 5 },
    { label: "Restore the Odyssey with the five original moons", from: 2600, through: frames + 1, reject: noBoss,
      accept: s => lunaGameData(s)?.moons === 5 && lunaGameData(s)?.homeRestored === true },
    { label: "Reach the original world-selection state", from: 4000, through: frames + 1, allowAfterReplay: true, reject: noBoss,
      accept: s => lunaGameData(s)?.homeRestored === true && /StageSceneStateWorldMapNrv(?:DemoWorldSelect|Wait)E/.test(lunaGameData(s)?.worldMapNerve ?? "") },
  ];
}
