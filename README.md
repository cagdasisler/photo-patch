# Photo Patch

**Created by Cagdas Emre Isler**

Photo Patch is a small Windows desktop app for one job: copy a box from a picture and paste it over another spot in the same picture. You can use it to cover up a blemish, hide something in the background, or fill a gap with a nearby texture. You can also add a signature to a picture, and do all of this to PDFs too.

Pasted pieces sit on top of your photo. They hide what's underneath without erasing it, so you can move, resize or remove any piece at any time before you save.

## Use it in your browser

Open **[photo-patch.vercel.app](https://photo-patch.vercel.app)**. The site first offers the Windows app; choose **Continue in browser** to use it right there, with nothing to install. It has every feature of the app, and your pictures stay on your device: nothing is uploaded.

In Chrome and Edge, *Save* opens a normal "Save as" window. In other browsers, you pick a name and format, and the picture goes to your downloads folder. Saved signatures are kept in that browser.

## Download the Windows app

Get the latest version from the [Releases page](https://github.com/cagdasisler/photo-patch/releases):

- **Photo.Patch-Setup-x.y.z.exe**: installs the app and adds Start menu and desktop shortcuts.
- **Photo.Patch-Portable-x.y.z.exe**: runs on its own, with nothing to install.

Windows SmartScreen may warn you the first time you run it, because the app isn't code-signed. Click **More info → Run anyway**.

## How to use it

1. **Open** a picture or a PDF with the *Open* button or `Ctrl+O`, or drag one into the window.
2. **Select** the part you want by dragging a box around it.
3. **Copy** it with the *Copy* button under the box, or press `Ctrl+C`.
4. **Paste** it by pointing where you want it and pressing `Ctrl+V`. Then drag the piece to fine-tune its position.
5. **Save** with the *Save* button or `Ctrl+S`.

Supported formats: PDF, PNG, JPG/JPEG, JFIF, WebP, GIF, BMP and AVIF for opening; PDF, PNG, JPG and WebP for saving.

### PDFs

Open a PDF like a picture. For a PDF with more than one page, switch pages with the arrows at the bottom, or `Page Up` and `Page Down`. Each page keeps its own pieces and its own undo, and you can copy from one page and paste on another.

Save as **PDF** to keep every page:

- Pages you didn't change stay exactly as they were.
- Pages where you only added a signature keep their text, with the signature on top.
- Pages where you covered or erased something are saved as a picture of the page. The covered text is really gone, not just hidden under a patch, so nobody can select or copy it out of the file.

You can also save just the page you're on as a PNG, JPG or WebP picture, or save a picture as a one-page PDF. PDFs locked with a password to open can't be opened; open an unlocked copy instead.

### Erase

Drag a box around something, then press `Delete` or click **Erase**. Photo Patch finds what stands out from the background in the box (a letter, a word, a stain, a sticker) and removes only that. It fills the gap to match what's around it: the paper's color, its shading and its grain. Lines and patterns that run through the box, like ruled lines or bricks, carry on through the gap. Anything in the box that is already background stays as it was.

Leave a little background around the thing you erase, so Photo Patch can see what to fill it with. To undo an erase, press `Ctrl+Z` or remove it from the **Pieces** list.

### Signatures

Click **Sign** to draw, type or upload a signature:

- **Draw** with a mouse, pen or finger, in black, blue or red ink.
- **Type** your name and pick a handwriting style.
- **Upload** a photo or scan of your signature. Photo Patch can remove the paper background for you.

Keep **Save for later** ticked, and the signature is kept for next time. Once you have saved signatures, **Sign** opens on the **Saved** tab: click one to add it to the picture, or click **New signature** to make another.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Drag | Select an area |
| `Shift` + drag | Select a perfect square |
| `Ctrl` + drag | Select over an existing piece |
| `Ctrl+C` | Copy the selection |
| `Ctrl+V` | Paste at the pointer |
| Drag a corner | Resize a piece |
| Arrow keys | Nudge a piece |
| `Delete` | Erase what's in the box, or remove the selected piece |
| `H` | Peek at the original picture |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `Ctrl+S` | Save |
| `Ctrl+O` | Open a picture or PDF |
| `Page Up` / `Page Down` | Previous / next PDF page |
| Scroll | Zoom |
| `Ctrl+0` | Fit the picture to the window |
| `Space` + drag | Pan around |

## Building from source

You'll need [Node.js](https://nodejs.org/) 20 or newer.

```bash
git clone https://github.com/cagdasisler/photo-patch.git
cd photo-patch
npm install
npm start        # run the app
npm run dist     # build the Windows installer and portable .exe into dist/
npm run icon     # regenerate build/icon.png

npm run web:build    # build the web version into web-dist/
npm run web:preview  # build it and serve it locally
npm run web:deploy   # publish it to Vercel (needs the Vercel CLI and `vercel login`)
```

Photo Patch is built with [Electron](https://www.electronjs.org/) and plain HTML, CSS and JavaScript, with no frameworks. The web version runs the same `src/` code: the files in `web/` replace Electron's file dialogs and storage with browser features, and add the download link.

## Author

Photo Patch was designed and created by **Cagdas Emre Isler**.

## License

[MIT](LICENSE) © Cagdas Emre Isler. You're free to use, copy, modify and share it.

The bundled Plus Jakarta Sans font is licensed under the [SIL Open Font License](src/fonts/OFL.txt). PDFs are read with [pdf.js](https://mozilla.github.io/pdf.js/) ([Apache 2.0](src/vendor/pdfjs/LICENSE)) and written with [pdf-lib](https://pdf-lib.js.org/) ([MIT](src/vendor/pdf-lib/LICENSE.md)), both bundled in `src/vendor/` (`npm run vendor` refreshes them).
