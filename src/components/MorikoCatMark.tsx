import { brandCatSvgUrl } from '../lib/brandAssets';


export function MorikoCatMark({ className }: { className?: string }) {
  return (
    <img
      src={brandCatSvgUrl}
      alt="Moriko cat logo"
      draggable={false}
      width={256}
      height={256}
      style={{ aspectRatio: '1 / 1' }}
      className={className}
    />
  );
}
