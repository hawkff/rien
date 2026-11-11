import { t } from '@/i18n';
import { waitForElement } from '@/utils/wait-for-element';

import type { QueueElement } from '@/types/queue';

// The newer player bar (ytmusic-miniplayer) opens the player page only through
// a click on the song's cover, which is easy to miss. This adds the arrow the
// older bar has at its end.
export const addPlayerPageButton = async () => {
  if (document.querySelector('ytmusic-player-bar')) return;
  const section = await waitForElement<HTMLElement>(
    'ytmusic-miniplayer .ytMusicMiniPlayerRightSection',
    { retryInterval: 500 },
  );
  const layout = document.querySelector('ytmusic-app-layout');
  if (!layout) return;

  const isOpen = () => layout.hasAttribute('player-page-open');
  const button = document.createElement('button');
  button.className = 'player-page-button';
  button.type = 'button';
  button.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M7.41 15.41 12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>';
  const update = () => {
    button.classList.toggle('open', isOpen());
    button.title = t(
      isOpen() ? 'main.player-bar.close-player' : 'main.player-bar.open-player',
    );
    button.setAttribute('aria-label', button.title);
  };
  button.addEventListener('click', () =>
    document.querySelector<QueueElement>('#queue')?.queue.store.store.dispatch({
      type: 'SET_PLAYER_PAGE_INFO',
      payload: { open: !isOpen() },
    }),
  );
  new MutationObserver(update).observe(layout, {
    attributes: true,
    attributeFilter: ['player-page-open'],
  });
  update();
  section.append(button);
};
