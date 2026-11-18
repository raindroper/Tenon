import { version } from '../../package.json';

export const windowsDesktopDownload = `/desktop-updates/Another-Rae-${version}-Setup.exe`;
// Installed clients verify the legacy URL. Browsers can save the same bytes under the current brand.
export const windowsDesktopFilename = `Tenon-${version}-Setup.exe`;

export function canShowWindowsDesktopDownload(): boolean {
  return typeof window === 'undefined' || !('raeLocalDevice' in window || window.navigator.userAgent.includes('Electron/'));
}
