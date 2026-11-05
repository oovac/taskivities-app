// "Install app" (add to home screen). Chrome/Edge/Android fire `beforeinstallprompt` when the app can be installed;
// we keep the event so the account menu can offer it. iPhones have no prompt: the menu explains Share → Add to Home Screen.
import { set } from './store';

interface InstallPrompt extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
let deferred: InstallPrompt | null = null;

window.addEventListener('beforeinstallprompt', (e) => {
  deferred = e as InstallPrompt; // the browser's own install button/banner still shows too
  set({ canInstall: true });
});
window.addEventListener('appinstalled', () => { deferred = null; set({ canInstall: false }); });

/** Already running from the home screen. */
export const isInstalled = () => matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export async function installApp() {
  if (!deferred) return;
  await deferred.prompt();
  await deferred.userChoice.catch(() => undefined);
  deferred = null;
  set({ canInstall: false });
}
