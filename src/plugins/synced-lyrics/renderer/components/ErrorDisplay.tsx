import { Show } from 'solid-js';

import { t } from '@/i18n';
import { getSongInfo } from '@/providers/song-info-front';

import { lyricsStore, retrySearch } from '../store';

interface ErrorDisplayProps {
  error: Error;
}

export const ErrorDisplay = (props: ErrorDisplayProps) => {
  return (
    <div class="lyrics-state" role="status">
      <p class="lyrics-state-message">
        {t('plugins.synced-lyrics.errors.fetch')}
      </p>
      {/* The reason, without the stack: that names files on this computer and
          is in the console. */}
      <Show when={props.error.message}>
        <p class="lyrics-state-detail">{props.error.message}</p>
      </Show>

      <yt-button-renderer
        data={{
          icon: { iconType: 'REFRESH' },
          isDisabled: false,
          style: 'STYLE_DEFAULT',
          text: {
            simpleText: t('plugins.synced-lyrics.refetch-btn.normal'),
          },
        }}
        onClick={() => retrySearch(lyricsStore.provider, getSongInfo())}
      />
    </div>
  );
};
