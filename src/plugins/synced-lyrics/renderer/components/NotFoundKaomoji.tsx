import { t } from '@/i18n';

export const NotFoundKaomoji = () => {
  return (
    <div class="lyrics-state">
      <yt-formatted-string
        aria-hidden="true"
        class="text-lyrics description ytmusic-description-shelf-renderer"
        style={{ 'user-select': 'none' }}
        text={{
          runs: [{ text: '＼(〇_ｏ)／' }],
        }}
      />
      <p class="lyrics-state-message">
        {t('plugins.synced-lyrics.errors.not-found')}
      </p>
    </div>
  );
};
