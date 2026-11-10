import i18next, { init, t as i18t, changeLanguage } from 'i18next';
import { languageResource } from 'virtual:i18n';

export const APPLICATION_NAME =
  '\u0059\u006f\u0075\u0054\u0075\u0062\u0065\u0020\u004d\u0075\u0073\u0069\u0063';

export const loadI18n = async () =>
  await init({
    resources: { en: { translation: (await languageResource('en')) ?? {} } },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
  });

// Languages load on first use. A language change needs a restart everywhere
// but the main process, so the other processes only hold the one in use.
export const setLanguage = async (language: string) => {
  // i18next falls back from pt-BR to pt before English, so load both.
  for (const code of new Set([language, language.split('-')[0]])) {
    if (!i18next.hasResourceBundle(code, 'translation')) {
      const resource = await languageResource(code);
      if (resource) i18next.addResourceBundle(code, 'translation', resource);
    }
  }
  return await changeLanguage(language);
};

export const t = i18t.bind(i18next);
