import { useState } from 'react';
import { ChevronLeft, ChevronRight, ImageIcon, LayoutPanelLeft, Trash2 } from './icons';

import { useStore } from '../store/useStore';
import { ImageLightbox } from './ImageLightbox';

/**
 * Gallery — the persistent, user-ordered image collection.
 *
 * Every entry lives server-side, so the collection survives reloads and is
 * shared by every browser that talks to this proxy. Hover a tile to move it
 * within the collection or remove it; click to view it full-size.
 */
export function Gallery() {
  const images = useStore((state) => state.galleryImages);
  const removeFromGallery = useStore((state) => state.removeFromGallery);
  const moveGalleryImage = useStore((state) => state.moveGalleryImage);
  const [lightbox, setLightbox] = useState<string | null>(null);

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-8">
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-lg font-semibold text-ink">
          <LayoutPanelLeft className="h-5 w-5 text-accent" aria-hidden="true" />
          Gallery
        </h1>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">
          Saved images from every session. Hover a tile to reorder or remove it; click to view
          it full-size.
        </p>
      </header>

      {images.length === 0 ? (
        <div className="rounded-card border border-dashed border-hairline px-4 py-16 text-center">
          <ImageIcon className="mx-auto h-7 w-7 text-faint" aria-hidden="true" />
          <p className="mt-3 text-[13px] text-muted">Your collection is empty.</p>
          <p className="mt-1 text-[12px] leading-relaxed text-faint">
            Generate something in Image Studio, then use the + button (or Save all) to pin
            results here.
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {images.map((url, index) => (
            <li key={url} className="group relative">
              <button
                type="button"
                onClick={() => setLightbox(url)}
                aria-label="Open full-size image"
                className="block aspect-square w-full overflow-hidden rounded-card border border-hairline"
              >
                <img
                  src={url}
                  alt="Gallery image"
                  loading="lazy"
                  className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                />
              </button>
              <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-black/45 p-1.5 opacity-0 backdrop-blur-sm transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => moveGalleryImage(url, -1)}
                  disabled={index === 0}
                  aria-label="Move earlier"
                  className="rounded p-1.5 text-white/80 transition-colors hover:text-white disabled:opacity-30"
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                </button>
                <span className="text-[11px] tabular-nums text-white/60">{index + 1}</span>
                <button
                  type="button"
                  onClick={() => removeFromGallery(url)}
                  aria-label="Remove from Gallery"
                  className="rounded p-1.5 text-white/80 transition-colors hover:text-danger"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => moveGalleryImage(url, 1)}
                  disabled={index === images.length - 1}
                  aria-label="Move later"
                  className="rounded p-1.5 text-white/80 transition-colors hover:text-white disabled:opacity-30"
                >
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {lightbox ? <ImageLightbox url={lightbox} onClose={() => setLightbox(null)} /> : null}
    </div>
  );
}
