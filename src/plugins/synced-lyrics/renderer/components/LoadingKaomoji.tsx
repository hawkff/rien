import { createSignal, onCleanup, onMount } from 'solid-js';

import { t } from '@/i18n';

const states = [
  '(>_<)',
  '{ (>_<) }',
  '{{ (>_<) }}',
  '{{{ (>_<) }}}',
  '{{ (>_<) }}',
  '{ (>_<) }',
];
export const LoadingKaomoji = () => {
  const [counter, setCounter] = createSignal(0);

  onMount(() => {
    const interval = setInterval(() => setCounter((old) => old + 1), 500);
    onCleanup(() => clearInterval(interval));
  });

  return (
    <yt-formatted-string
      aria-label={t('plugins.synced-lyrics.refetch-btn.fetching')}
      class="text-lyrics description ytmusic-description-shelf-renderer"
      role="img"
      style={{
        'display': 'inline-flex',
        'justify-content': 'center',
        'width': '100%',
        'user-select': 'none',
      }}
      text={{
        runs: [{ text: states[counter() % states.length] }],
      }}
    />
  );
};
