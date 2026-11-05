// The files every demo upload is stored as (samples/sample.png for images, samples/sample.pdf for anything else).
// Vite's ?inline puts them in the Worker's bundle as data URLs; they're turned back into bytes once.
import pdfUrl from './samples/sample.pdf?inline';
import pngUrl from './samples/sample.png?inline';

const bytes = (dataUrl: string) => Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0));

export const SAMPLE_PNG = bytes(pngUrl);
export const SAMPLE_PDF = bytes(pdfUrl);
export const SAMPLE_TEXT = new TextEncoder().encode(
  'Sample file\n\nThis is the Taskivities demo, so files aren\'t stored: every upload is kept as a sample instead.\n' +
  'On your own instance the real file is kept. Run your own: https://www.taskivities.com/open-source\n',
);
