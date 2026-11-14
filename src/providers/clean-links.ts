import { cleanLink } from '@/utils/clean-link';

// The site's Share > Copy link selects the link in its box and runs the copy
// command; the clipboard API is the other way a page copies. Links to the
// site that go either way lose their tracking.
export const cleanCopiedLinks = () => {
  document.addEventListener(
    'copy',
    (event) => {
      const field = event.composedPath()[0];
      const text =
        field instanceof HTMLInputElement ||
        field instanceof HTMLTextAreaElement
          ? field.value.slice(
              field.selectionStart ?? 0,
              field.selectionEnd ?? field.value.length,
            )
          : String(document.getSelection());
      const clean = cleanLink(text);
      if (clean === text || !event.clipboardData) return;
      event.clipboardData.setData('text/plain', clean);
      event.preventDefault();
    },
    true,
  );
  const { clipboard } = navigator;
  const writeText = clipboard.writeText.bind(clipboard);
  clipboard.writeText = (text) => writeText(cleanLink(text));
};
