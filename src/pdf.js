'use strict';

// PDF support: pdf.js draws each page as a picture to edit, and pdf-lib writes the
// edited PDF. Both are bundled in vendor/ and only loaded when a PDF is involved.
const PdfFiles = (() => {
  const VENDOR = new URL('vendor/', document.baseURI).href;
  const RENDER_DPI = 200; // sharp enough to print, and to read small print when zoomed in
  const MAX_SIDE = 5000; // pixels; keeps poster-sized pages within canvas limits
  const IMAGE_DPI = 96; // a picture saved as a PDF gets one page at this size

  let pdfjsLoading = null;
  let pdfLibLoading = null;

  function pdfjs() {
    pdfjsLoading ||= import(`${VENDOR}pdfjs/pdf.min.mjs`).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = `${VENDOR}pdfjs/pdf.worker.min.mjs`;
      return lib;
    });
    return pdfjsLoading;
  }

  function pdfLib() {
    pdfLibLoading ||= new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${VENDOR}pdf-lib/pdf-lib.min.js`;
      script.onload = () => resolve(window.PDFLib);
      script.onerror = () => {
        pdfLibLoading = null;
        reject(new Error('Couldn’t load the PDF writer.'));
      };
      document.head.append(script);
    });
    return pdfLibLoading;
  }

  // PDFs start with "%PDF-", though some have a little junk before it.
  function isPdf(head) {
    const text = String.fromCharCode(...head.subarray(0, 1024));
    return text.includes('%PDF-');
  }

  class PasswordError extends Error {}

  // Opens a PDF and reads each page's size. Pages are drawn later, when shown.
  async function open(bytes) {
    const lib = await pdfjs();
    const task = lib.getDocument({
      data: bytes.slice(), // pdf.js takes over the buffer it's given; keep ours for saving
      cMapUrl: `${VENDOR}pdfjs/cmaps/`,
      standardFontDataUrl: `${VENDOR}pdfjs/standard_fonts/`,
      wasmUrl: `${VENDOR}pdfjs/wasm/`,
      iccUrl: `${VENDOR}pdfjs/iccs/`,
      isEvalSupported: false,
      enableXfa: false,
    });
    task.onPassword = () => task.destroy();
    let doc;
    try {
      doc = await task.promise;
    } catch (err) {
      if (err?.name === 'PasswordException' || task.destroyed) throw new PasswordError('This PDF is locked with a password.');
      throw err;
    }

    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const { width, height } = page.getViewport({ scale: 1 }); // points, after the page's own rotation
      pages.push({ width, height });
      page.cleanup();
    }

    return {
      bytes,
      pages,
      async render(index) {
        const page = await doc.getPage(index + 1);
        const { width, height } = pages[index];
        const scale = Math.min(RENDER_DPI / 72, MAX_SIDE / Math.max(width, height));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const g = canvas.getContext('2d');
        g.fillStyle = '#fff'; // paper
        g.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: g, viewport }).promise;
        page.cleanup();
        return createImageBitmap(canvas);
      },
      close: () => task.destroy(),
    };
  }

  function encode(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, quality);
    });
  }

  // A whole page as one picture: JPEG for photos and scans, PNG when that's smaller
  // (plain text and drawings), so the file stays small without blurring the text.
  async function embedPage(out, canvas) {
    const [jpg, png] = await Promise.all([encode(canvas, 'image/jpeg', 0.92), encode(canvas, 'image/png')]);
    const smaller = png.size <= jpg.size ? png : jpg;
    const bytes = new Uint8Array(await smaller.arrayBuffer());
    return smaller === png ? out.embedPng(bytes) : out.embedJpg(bytes);
  }

  /**
   * Writes the edited PDF.
   * source: the opened PDF (from open()), or null when the picture is an image.
   * pages: [{ width, height, edit }] in points; edit is null (untouched), 'overlay'
   *   (only adds things on top, like a signature) or 'flatten' (covers something up).
   * draw(index, layer): resolves to a canvas of the page at its editing size, with 'pieces' only
   *   (transparent elsewhere) or 'all' (the page as it looks, pieces included).
   * Untouched pages are kept exactly as they were. Overlay pages keep their text and
   * get the additions on top. Flattened pages become one picture, so whatever was
   * covered is really gone, not just hidden behind a patch.
   */
  async function save(source, pages, draw) {
    const { PDFDocument } = await pdfLib();
    let out = null;
    if (source) {
      try {
        out = await PDFDocument.load(source.bytes, { updateMetadata: false });
      } catch {
        out = null; // encrypted or unusual: rebuild it from the pages as drawn
      }
    }

    let flattened = 0;
    if (out) {
      for (let i = 0; i < pages.length; i++) {
        const { width, height, edit } = pages[i];
        if (!edit) continue;
        const page = out.getPage(i);
        const box = page.getCropBox();
        const fits =
          page.getRotation().angle % 360 === 0 && Math.abs(box.width - width) < 1 && Math.abs(box.height - height) < 1;
        if (edit === 'overlay' && fits) {
          const layer = await encode(await draw(i, 'pieces'), 'image/png');
          const image = await out.embedPng(new Uint8Array(await layer.arrayBuffer()));
          page.drawImage(image, { x: box.x, y: box.y, width: box.width, height: box.height });
        } else {
          const image = await embedPage(out, await draw(i, 'all'));
          out.removePage(i);
          out.insertPage(i, [width, height]).drawImage(image, { x: 0, y: 0, width, height });
          flattened++;
        }
      }
    } else {
      out = await PDFDocument.create();
      for (let i = 0; i < pages.length; i++) {
        const { width, height } = pages[i];
        const image = await embedPage(out, await draw(i, 'all'));
        out.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
      }
      if (source) flattened = pages.length;
    }

    out.setProducer('Photo Patch');
    return { bytes: await out.save(), flattened };
  }

  return {
    isPdf,
    open,
    save,
    PasswordError,
    imagePageSize: (w, h) => ({ width: (w * 72) / IMAGE_DPI, height: (h * 72) / IMAGE_DPI }),
  };
})();
