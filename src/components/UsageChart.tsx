import { useMemo, useState } from 'react';


export interface UsageDay {
  date: string;
  requests: number;
  prompt: number;
  completion: number;
  total: number;
  cacheRead: number;
}

interface Bucket {
  date: string;
  end: string;
  requests: number;
  prompt: number;
  completion: number;
  total: number;
  cacheRead: number;
}


function compact(value: number): string {
  if (value >= 1e9) return `${+(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${+(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`;
  if (value >= 1e3) {
    const k = +(value / 1e3).toFixed(1);
    return k >= 1000 ? `${+(value / 1e6).toFixed(1)}M` : `${k}K`;
  }
  return Number.isInteger(value) ? String(value) : String(+value.toFixed(1));
}


function niceScale(peak: number): { step: number; lines: number } {
  if (peak <= 0) return { step: 0, lines: 4 };
  const target = Math.max(peak / 5, 1);
  const power = 10 ** Math.floor(Math.log10(target));
  const step =
    [1, 2, 2.5, 5, 10].map((multiplier) => multiplier * power).find((candidate) => candidate >= target) ??
    10 * power;
  return { step, lines: Math.ceil(peak / step) };
}

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}


function bucketize(days: UsageDay[]): { buckets: Bucket[]; unit: string } {
  const size = days.length <= 30 ? 1 : days.length <= 180 ? 7 : 30;
  const unit = size === 1 ? 'day' : size === 7 ? 'week' : 'month';
  const buckets: Bucket[] = [];
  for (let index = 0; index < days.length; index += size) {
    const chunk = days.slice(index, index + size);
    const fold = (key: 'requests' | 'prompt' | 'completion' | 'total' | 'cacheRead'): number =>
      chunk.reduce((total, row) => total + row[key], 0);
    buckets.push({
      date: chunk[0].date,
      end: chunk[chunk.length - 1].date,
      requests: fold('requests'),
      prompt: fold('prompt'),
      completion: fold('completion'),
      total: fold('total'),
      cacheRead: fold('cacheRead'),
    });
  }
  return { buckets, unit };
}


const FLIP_ABOVE_MAX_PCT = 45;
const FLIP_BELOW_CLAMP_PX = 110;
export function UsageChart({ days }: { days: UsageDay[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const { buckets, unit } = useMemo(() => bucketize(days), [days]);

  if (buckets.length === 0) return null;

  const totals = buckets.map((bucket) => bucket.total);
  const rawMax = Math.max(...totals);
  const { step, lines } = niceScale(rawMax);
  const max = step * lines;
  
  const pct = (value: number): number => (max > 0 ? (value / max) * 100 : 0);
  const peakIndex = totals.indexOf(rawMax);
  const hovered = hover !== null ? buckets[hover] : null;
  const hoveredRange =
    hovered && hovered.date !== hovered.end
      ? `${shortDate(hovered.date)} – ${shortDate(hovered.end)}`
      : hovered
        ? shortDate(hovered.date)
        : '';
  
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 8));

  return (
    <div>
      <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: 'var(--faint)' }}>
        <span>Tokens per {unit}</span>
        <span>
          {rawMax > 0 ? `Peak ${compact(totals[peakIndex])} · ${shortDate(buckets[peakIndex].date)}` : ''}
        </span>
      </div>

      <div className="chart">
        <div className="yax">
          {Array.from({ length: lines + 1 }, (_, index) => (
            <span key={index}>{compact(step * (lines - index))}</span>
          ))}
        </div>
        <div className="plot">
          <div className="gridl" aria-hidden="true">
            {Array.from({ length: lines + 1 }, (_, index) => (
              <i key={index} />
            ))}
          </div>

          <div className="bars">
            {buckets.map((bucket, index) => (
              <div
                key={bucket.date}
                className={bucket.total > 0 ? 'bar' : 'bar z'}
                onMouseEnter={() => setHover(index)}
                onMouseLeave={() => setHover(null)}
              >
                <i
                  style={
                    {
                      '--h': `${pct(bucket.total)}%`,
                      '--dl': `${index * 35}ms`,
                    } as React.CSSProperties
                  }
                />
              </div>
            ))}
          </div>

          {hover !== null && hovered ? (() => {
            const valuePct = pct(totals[hover]);
            const above = valuePct <= FLIP_ABOVE_MAX_PCT;
            return (
              <div
                role="tooltip"
                className="tip show"
                style={{
                  pointerEvents: 'none',
                  position: 'absolute',
                  zIndex: 10,
                  transform: 'translateX(-50%)',
                  whiteSpace: 'nowrap',
                  borderRadius: 'var(--r-md)',
                  border: '1px solid var(--line)',
                  background: 'rgb(var(--c-elev))',
                  padding: '8px 10px',
                  fontSize: 11,
                  lineHeight: 1.625,
                  boxShadow: 'var(--sh2)',
                  left: `${Math.min(Math.max(((hover + 0.5) / buckets.length) * 100, 12), 88)}%`,
                  ...(above
                    ? { bottom: `calc(${valuePct}% + 6px)` }
                    :
                      { top: `min(calc(${(100 - valuePct).toFixed(2)}% + 6px), ${FLIP_BELOW_CLAMP_PX}px)` }),
                }}
              >
                <p style={{ margin: 0, fontSize: 12, fontWeight: 500, color: 'rgb(var(--c-ink))' }}>{hoveredRange}</p>
                <p style={{ margin: 0, color: 'var(--faint)' }}>
                  Total <span style={{ fontVariantNumeric: 'tabular-nums', color: 'rgb(var(--c-ink))' }}>{hovered.total.toLocaleString()}</span>
                </p>
                <p style={{ margin: 0, color: 'var(--faint)' }}>
                  Prompt <span style={{ fontVariantNumeric: 'tabular-nums', color: 'rgb(var(--c-ink))' }}>{hovered.prompt.toLocaleString()}</span>
                </p>
                <p style={{ margin: 0, color: 'var(--faint)' }}>
                  Output <span style={{ fontVariantNumeric: 'tabular-nums', color: 'rgb(var(--c-ink))' }}>{hovered.completion.toLocaleString()}</span>
                </p>
                {hovered.cacheRead > 0 ? (
                  <p style={{ margin: 0, color: 'var(--faint)' }}>
                    Cache <span style={{ fontVariantNumeric: 'tabular-nums', color: 'rgb(var(--c-ink))' }}>{hovered.cacheRead.toLocaleString()}</span>
                  </p>
                ) : null}
              </div>
            );
          })() : null}
        </div>
      </div>

      <div className="xax">
        {buckets.map((bucket, index) => (
          <span key={bucket.date}>
            {index % labelEvery === 0 || index === buckets.length - 1 ? shortDate(bucket.date) : ''}
          </span>
        ))}
      </div>
    </div>
  );
}
