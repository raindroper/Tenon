import type { DesktopBuildProfile } from './build-profile.js';

/** Generic source defaults. A publisher can embed an explicit private profile when building. */
export const desktopProfile: DesktopBuildProfile = Object.freeze({
  appId: 'org.anotherrae.desktop',
  baseUrl: '',
  updates: null,
});
