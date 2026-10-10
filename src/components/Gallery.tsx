import { useEffect, useMemo, useRef, useState } from 'react';

import { Download, Wand2 } from './icons';
import { brandEmptyDownloadSvg } from '../lib/brandAssets';
import { useStore } from '../store/useStore';
import { ImageLightbox } from './ImageLightbox';
import { cx } from './ui';

/** Design's download filename: moriko-<prompt-slug>.jpg */
const downloadImage = (url: string, prompt: string) => {
  const slug =
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'image';
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `moriko-${slug}.jpg`;
  anchor.click();
};

/**
 * Gallery — the design's card grid (design/image-viewer.html): a
 * page-head with a live count, a drag (or Alt+←/→) reorderable card grid,
 * and the shared lightbox with prev/next through the whole collection.
 *
 * Every entry lives server-side, so the collection survives reloads and is
 * shared by every browser that talks to this proxy.
 */
export function Gallery() {
  const images = useStore((state) => state.galleryImages);
  const sessions = useStore((state) => state.imageSessions);
  const removeFromGallery = useStore((state) => state.removeFromGallery);
  const moveGalleryImage = useStore((state) => state.moveGalleryImage);
  const reorderGalleryImages = useStore((state) => state.reorderGalleryImages);
  const setView = useStore((state) => state.setView);
  const requestImageStudioPrompt = useStore((state) => state.requestImageStudioPrompt);
  /** Refetch on every mount — the view may be showing a stale store cache
   *  from before another tab (or the agent) appended new images. */
  const loadGallery = useStore((state) => state.loadGallery);
  useEffect(() => {
    void loadGallery();
  }, [loadGallery]);
  const [lightbox, setLightbox] = useState<string | null>(null);
  /** HTML5 drag: which tile is being dragged + which one is the drop target. */
  const dragIdRef = useRef<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  /** Viewer info: the prompt + session label each gallery image came from. */
  const infoByUrl = useMemo(() => {
    const map = new Map<string, { prompt: string; label: string }>();
    for (const session of sessions) {
      for (const item of session.items) {
        if (!map.has(item.url)) map.set(item.url, { prompt: item.prompt, label: session.label });
      }
    }
    return map;
  }, [sessions]);

  // Removing the open image (lightbox save) shrinks the list — close it.
  useEffect(() => {
    if (lightbox && !images.includes(lightbox)) setLightbox(null);
  }, [images, lightbox]);

  const dropOn = (target: string) => {
    const from = dragIdRef.current;
    if (!from || from === target) return;
    void reorderGalleryImages(images.indexOf(from), images.indexOf(target));
  };

  const clearDrag = () => {
    dragIdRef.current = null;
    setDragId(null);
    setOverId(null);
  };

  return (
    <div className="page view-enter">
      <div className="page-head">
        <div>
          <h2>Gallery</h2>
          <p>{images.length} saved · drag (or Alt ←/→) to reorder</p>
        </div>
        <div className="acts">
          <button type="button" className="btn ghost" onClick={() => setView('imagestudio')}>
            <Wand2 className="ic" aria-hidden="true" />
            Open studio
          </button>
        </div>
      </div>

      {images.length === 0 ? (
        <div className="empty">
          <div className="eic">
            <span
              className="ic"
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: brandEmptyDownloadSvg }}
            />
          </div>
          <b>Your collection is empty</b>
          <p>
            Generate something in Image Studio, then press the save icon (or Save all) to pin
            results here.
          </p>
        </div>
      ) : (
        <ul
          className="icards"
          style={{ listStyle: 'none', padding: 0, margin: 0 }}
          onDragOver={(event) => {
            if (!dragIdRef.current) return;
            event.preventDefault();
          }}
          onDrop={(event) => {
            const tile = (event.target as HTMLElement).closest<HTMLElement>('.icard');
            const target = tile?.dataset.img;
            if (target) {
              event.preventDefault();
              dropOn(target);
            }
            clearDrag();
          }}
          onDragEnd={clearDrag}
        >
          {images.map((url) => {
            const info = infoByUrl.get(url);
            const prompt = info?.prompt ?? '';
            return (
              <li key={url}>
                <div
                  className={cx('icard', dragId === url && 'drag', overId === url && 'over')}
                  data-img={url}
                  role="button"
                  tabIndex={0}
                  aria-label={prompt || 'Gallery image'}
                  draggable
                  onClick={() => setLightbox(url)}
                  onKeyDown={(event) => {
                    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
                      event.preventDefault();
                      void moveGalleryImage(url, event.key === 'ArrowLeft' ? -1 : 1);
                    } else if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setLightbox(url);
                    }
                  }}
                  onDragStart={(event) => {
                    dragIdRef.current = url;
                    setDragId(url);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', url);
                  }}
                  onDragEnter={() => {
                    if (dragIdRef.current && dragIdRef.current !== url) setOverId(url);
                  }}
                  onDragOver={(event) => {
                    if (!dragIdRef.current) return;
                    event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.stopPropagation();
                    event.preventDefault();
                    dropOn(url);
                  }}
                >
                  <img src={url} alt="" loading="lazy" draggable={false} />
                  <div className="tov">
                    <div className="tbtns">
                      <button
                        type="button"
                        aria-label="Download"
                        onClick={(event) => {
                          event.stopPropagation();
                          downloadImage(url, prompt);
                        }}
                      >
                        <Download className="ic" aria-hidden="true" />
                      </button>
                    </div>
                    <span className="tcap">{prompt || 'Gallery image'}</span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {lightbox ? (
        <ImageLightbox
          url={lightbox}
          urls={images}
          onNavigate={setLightbox}
          title={infoByUrl.get(lightbox)?.label}
          prompt={infoByUrl.get(lightbox)?.prompt}
          onUsePrompt={(value) => {
            requestImageStudioPrompt(value);
            setView('imagestudio');
          }}
          saved
          onToggleSave={() => void removeFromGallery(lightbox)}
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </div>
  );
}
