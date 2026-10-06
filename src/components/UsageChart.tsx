import { useMemo, useState } from 'react';

/** One calendar day of the server usage ledger (local day, zeros pre-filled). */
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

/** 12.4M / 340K / 2.5K / 950 — compact axis + tooltip numbers. Dynamic
 *  scales land on 2.5× steps, so non-integer values print exactly. */
function compact(value: number): string {
  if (value >= 1e9) return `${+(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${+(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`;
  if (value >= 1e3) {
    const k = +(value / 1e3).toFixed(1);
    return k >= 1000 ? `${+(value / 1e6).toFixed(1)}M` : `${k}K`;
  }
  return Number.isInteger(value) ? String(value) : String(+value.toFixed(1));
}

/**
 * DYNAMIC axis: a clean step (1/2/2.5/5/10×10^k) ≈ peak/5, then 3–5 grid
 * lines at exact multiples of it. The ceiling hugs whatever the busiest
 * bucket holds — a 222M peak renders against a 250M axis instead of a fixed
 * niceMax 500M — and shrinks back automatically on quiet windows.
 */
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

/**
 * Bucket long ranges so bars stay readable: ≤30 rows → per day,
 * ≤180 → per week, beyond → per month. Returns the aggregation unit label.
 */
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

/**
 * Daily token bar chart (Claude's reference mechanism, Moriko theming):
 * zero-filled day series → bucketed bars, round grid lines, hover tooltip
 * with the prompt/output/cache split, peak + start/end axis labels.
 *
 * Tooltip placement: the chart box is a fixed 170px and the pill ~110px
 * (5 lines with Cache) + 6px gap ⇒ ~32% of headroom is the most a bar can
 * have while the pill still fits ABOVE its top — 30% leaves margin. Taller
 * bars flip the pill BELOW the bar top (over the bar itself). The pill's
 * near edge is anchored with NO y-translate: the old -translate-y-full
 * lifted it a second full height upward, out of the chart box and into the
 * card's overflow-hidden clip (the cut-off pill in the screenshot).
 */
const FLIP_ABOVE_MAX_PCT = 30;
export function UsageChart({ days }: { days: UsageDay[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const { buckets, unit } = useMemo(() => bucketize(days), [days]);

  if (buckets.length === 0) return null;

  const totals = buckets.map((bucket) => bucket.total);
  const rawMax = Math.max(...totals);
  const { step, lines } = niceScale(rawMax);
  const max = step * lines;
  /** Bar/tooltip height; 0 when the window is empty (grid then reads all 0). */
  const pct = (value: number): number => (max > 0 ? (value / max) * 100 : 0);
  const peakIndex = totals.indexOf(rawMax);
  const hovered = hover !== null ? buckets[hover] : null;
  const hoveredRange =
    hovered && hovered.date !== hovered.end
      ? `${shortDate(hovered.date)} – ${shortDate(hovered.end)}`
      : hovered
        ? shortDate(hovered.date)
        : '';

  return (
    <div className="border-b border-hairline px-4 py-3">
      <div className="mb-3 flex items-center justify-between text-[11px] text-faint">
        <span>Tokens per {unit}</span>
        <span>
          {rawMax > 0 ? `Peak ${compact(totals[peakIndex])} · ${shortDate(buckets[peakIndex].date)}` : ''}
        </span>
      </div>

      <div className="relative ml-10 h-[170px]">
        {/* Adaptive grid: 3–5 round steps derived from the peak, not a fixed 4. */}
        {Array.from({ length: lines + 1 }, (_, index) => (
          <div
            key={index}
            className="absolute inset-x-0 border-t border-dashed border-hairline"
            style={{ bottom: `${(index / lines) * 100}%` }}
          >
            <span className="absolute -left-10 -top-2 w-8 text-right text-[10px] tabular-nums text-faint">
              {compact(step * index)}
            </span>
          </div>
        ))}

        <div className="absolute inset-0 flex items-end gap-[3px]">
          {buckets.map((bucket, index) => (
            <div
              key={bucket.date}
              className="group relative flex h-full flex-1 items-end"
              onMouseEnter={() => setHover(index)}
              onMouseLeave={() => setHover(null)}
            >
              <div
                className="w-full rounded-t-[3px] bg-accent opacity-75 transition-opacity group-hover:opacity-100"
                style={{ height: `${pct(bucket.total)}%`, minHeight: 2 }}
              />
            </div>
          ))}
        </div>

        {hover !== null && hovered ? (() => {
          const valuePct = pct(totals[hover]);
          // Above for short bars (pill still fits under the box ceiling);
          // below for tall ones — pinned to the bar top, never translated up.
          const above = valuePct <= FLIP_ABOVE_MAX_PCT;
          return (
            <div
              role="tooltip"
              className="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-control border border-hairline bg-elevated px-2.5 py-2 text-[11px] leading-relaxed shadow-popover"
              style={{
                left: `${Math.min(Math.max(((hover + 0.5) / buckets.length) * 100, 12), 88)}%`,
                ...(above
                  ? { bottom: `calc(${valuePct}% + 6px)` }
                  : // Bar-top edge from the TOP of the box is (100 − valuePct)%;
                    // clamp at 57px (170 chart − ~107 tooltip − 6 margin) so a
                    // mid-height bar can't push the tooltip past the box bottom.
                    { top: `min(calc(${(100 - valuePct).toFixed(2)}% + 6px), 57px)` }),
              }}
            >
              <p className="text-[12px] font-medium text-ink">{hoveredRange}</p>
              <p className="text-faint">
                Total <span className="tabular-nums text-ink">{hovered.total.toLocaleString()}</span>
              </p>
              <p className="text-faint">
                Prompt <span className="tabular-nums text-ink">{hovered.prompt.toLocaleString()}</span>
              </p>
              <p className="text-faint">
                Output <span className="tabular-nums text-ink">{hovered.completion.toLocaleString()}</span>
              </p>
              {hovered.cacheRead > 0 ? (
                <p className="text-faint">
                  Cache <span className="tabular-nums text-ink">{hovered.cacheRead.toLocaleString()}</span>
                </p>
              ) : null}
            </div>
          );
        })() : null}
      </div>

      <div className="ml-10 mt-2 flex justify-between text-[10px] text-faint">
        <span>{shortDate(buckets[0].date)}</span>
        <span>{shortDate(buckets[buckets.length - 1].end)}</span>
      </div>
    </div>
  );
}
