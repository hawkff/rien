// Romanizes the scripts that the native module leaves out. Runs in the main
// process, where each library loads on its first use, so the page never holds
// them.
const thaiSegmenter = Intl.Segmenter.supportedLocalesOf('th').includes('th')
  ? new Intl.Segmenter('th', { granularity: 'word' })
  : null;

const romanizers: Record<string, (line: string) => Promise<string>> = {
  async ko(line) {
    // hanja's main module keeps its functions on a default export, which a
    // dynamic import wraps once more, so import the function's own module.
    const [{ romanize }, { translate }] = await Promise.all([
      import('es-hangul'),
      import('hanja/lib/translate'),
    ]);
    return romanize(translate(line, 'SUBSTITUTION'));
  },

  async zh(line) {
    const { pinyin } = await import('pinyin-pro');
    return line.replaceAll(/[\u4E00-\u9FFF]+/g, (match) => {
      return pinyin(match, { separator: ' ' });
    });
  },

  async th(line) {
    const { romanize: romanizeThaiFrag } =
      await import('@dehoist/romanize-thai');
    if (!thaiSegmenter) return romanizeThaiFrag(line);

    const segments = Array.from(thaiSegmenter.segment(line));
    const latin = segments
      .map((segment) =>
        segment.isWordLike
          ? romanizeThaiFrag(segment.segment)
          : segment.segment.trim(),
      )
      .join(' ')
      .trim();

    return latin;
  },

  async bn(line) {
    const { default: Sanscript } =
      await import('@indic-transliteration/sanscript');
    let out = Sanscript.t(line, 'bengali', 'iast');
    out = out.normalize('NFD');
    out = out.replace(/[\u0300-\u036f]/g, '');
    out = out.replace(/[\u09BC\u09BE-\u09CD]/g, '');
    return out.toLowerCase();
  },

  async hi(line) {
    const { default: Sanscript } =
      await import('@indic-transliteration/sanscript');
    let out = Sanscript.t(line, 'devanagari', 'iast');
    out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // strip accents
    return out.replace(/[^a-zA-Z\s]/g, '') || line; // remove any remaining symbols
  },
};

// A line the libraries can't handle stays as it is.
export const romanize = async (language: string, line: string) => {
  if (!Object.hasOwn(romanizers, language) || typeof line !== 'string') {
    return line;
  }
  try {
    return await romanizers[language](line);
  } catch (error: unknown) {
    console.error(`Could not romanize (${language}):`, error);
    return line;
  }
};
