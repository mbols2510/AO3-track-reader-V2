export { startTracker } from './tracker.ts';
export { startUnitConv } from './unitconv.ts';
export type { Bridge, WorkDetails, PageTitle } from './bridge.ts';

import { startTracker } from './tracker.ts';
import { startUnitConv } from './unitconv.ts';
import type { Bridge } from './bridge.ts';
import { UnitConv } from '@ao3track/core';

const DARK_SKIN = '/stylesheets/skins/skin_929_reversi/1_user_all_.css';

/** Run everything on an AO3 page. */
export function run(bridge: Bridge) {
  const s = bridge.settings;
  if (s.override_site_theme && s.theme === 'dark' && !document.querySelector(`link[href="${DARK_SKIN}"]`)) {
    const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: DARK_SKIN });
    document.head.append(link);
  }
  const api = startTracker(bridge);
  const u = s.unitConv;
  if (u.temp !== UnitConv.None || u.dist !== UnitConv.None || u.volume !== UnitConv.None || u.weight !== UnitConv.None) {
    try { startUnitConv(s); } catch (e) { console.warn('Ao3Track unit conversion failed', e); }
  }
  return api;
}
