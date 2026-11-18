#!/usr/bin/env python3
"""
pindai.py — Pemindai & Pembasmi Komentar Bintang Dua (/** ... */)
Tanpa pemotongan karakter, kebal folder sampah (.moriko), dan dilengkapi mode --hapus.
"""

import argparse
import bisect
import csv
import io
import json
import os
import re
import shutil
import sys
import time
from dataclasses import dataclass

C_LIKE = dict(line=("//",), block=(("/*", "*/"),), quotes=('"', "'", "`"), triple=False)
HASH = dict(line=("#",), block=(), quotes=('"', "'"), triple=True)
PHP = dict(line=("//", "#"), block=(("/*", "*/"),), quotes=('"', "'"), triple=False)


def _build_token_re(cfg):
    toks = [re.escape(op) for op, _ in cfg["block"]]
    toks += [re.escape(lp) for lp in cfg["line"]]
    for q in cfg["quotes"]:
        if cfg["triple"]:
            toks.append(re.escape(q * 3))
        toks.append(re.escape(q))
    return re.compile("|".join(toks))


for _cfg in (C_LIKE, HASH, PHP):
    _cfg["re"] = _build_token_re(_cfg)

EXT_CONFIG = {}
for _e in (".c .h .cpp .hpp .cc .cxx .cs .java .js .jsx .mjs .cjs .ts .tsx .go .rs "
           ".kt .kts .swift .scala .dart .groovy .m .mm .css .scss .less .sql .vue .svelte").split():
    EXT_CONFIG[_e] = C_LIKE
for _e in ".py .sh .bash .zsh .rb .yml .yaml .toml .pl .r .ps1 .mk .cfg .ini".split():
    EXT_CONFIG[_e] = HASH
EXT_CONFIG[".php"] = PHP

SKIP_DIRS = {
    ".git", ".moriko", ".hg", ".svn", "node_modules", "__pycache__",
    ".venv", "venv", "env", "dist", "build", "out", "coverage",
    ".idea", ".vscode", ".next", ".nuxt", ".turbo", "target", ".cache",
}
MAX_FILE_BYTES = 2 * 1024 * 1024

LINE_MARKER = re.compile(r"^\s*\*\*(?!\*)")


@dataclass
class Hit:
    text: str
    path: str
    start_line: int
    start_col: int
    end_line: int
    kind: str  # "block" | "line"


class Reporter:
    def __init__(self, enabled: bool):
        self.enabled = enabled
        self._last = 0.0
        self._t0 = time.monotonic()

    def elapsed(self) -> float:
        return time.monotonic() - self._t0

    @staticmethod
    def _width() -> int:
        return max(shutil.get_terminal_size((100, 20)).columns - 1, 40)

    @staticmethod
    def tail(s: str, n: int) -> str:
        return s if len(s) <= n else "..." + s[-(n - 3):]

    def show(self, msg: str, force: bool = False):
        if not self.enabled:
            return
        now = time.monotonic()
        if not force and now - self._last < 0.08:
            return
        self._last = now
        w = self._width()
        if len(msg) > w:
            msg = msg[: w - 3] + "..."
        sys.stderr.write("\r" + msg.ljust(w))
        sys.stderr.flush()

    def finish(self, msg: str):
        if not self.enabled:
            return
        w = self._width()
        sys.stderr.write("\r" + msg.ljust(w) + "\n")
        sys.stderr.flush()


def fmt_time(sec: float) -> str:
    sec = int(sec)
    return f"{sec // 60}m{sec % 60:02d}s" if sec >= 60 else f"{sec}s"


def is_two_star_block(raw: str) -> bool:
    return len(raw) > 4 and raw.startswith("/**") and raw[3] not in "*/"


def clean_block(raw: str, close: str) -> str:
    body = raw[3:]  # buang tepat "/**"
    if body.endswith(close):
        body = body[: -len(close)]
    body = body.rstrip("*").strip()
    lines = [re.sub(r"^\s*\*\s?", "", ln).strip() for ln in body.splitlines()]
    cleaned = " ".join(ln for ln in lines if ln)
    return cleaned if cleaned else "(komentar kosong)"


def scan_text(text: str, cfg: dict, path: str, only_block: bool, delete_mode: bool = False):
    n = len(text)
    tok_re = cfg["re"]
    line_starts = None

    def pos(offset):
        nonlocal line_starts
        if line_starts is None:
            line_starts = [0] + [m.end() for m in re.finditer(r"\n", text)]
        ln = bisect.bisect_right(line_starts, offset)
        return ln, offset - line_starts[ln - 1] + 1

    hits, spans_to_remove, i = [], [], 0
    while True:
        m = tok_re.search(text, i)
        if not m:
            break
        i, tok = m.start(), m.group()

        # 1) Komentar blok
        handled = False
        for op, cl in cfg["block"]:
            if tok == op:
                end = text.find(cl, i + len(op))
                end = n if end == -1 else end + len(cl)
                raw = text[i:end]
                if is_two_star_block(raw):
                    sl, sc = pos(i)
                    el, _ = pos(max(end - 1, i))
                    hits.append(Hit(clean_block(raw, cl), path, sl, sc, el, "block"))
                    if delete_mode:
                        spans_to_remove.append((i, end))
                i, handled = end, True
                break
        if handled:
            continue

        # 2) Komentar baris
        if tok in cfg["line"]:
            end = text.find("\n", i)
            end = n if end == -1 else end
            body = text[i + len(tok):end]
            if not only_block and LINE_MARKER.match(body):
                sl, sc = pos(i)
                isi = re.sub(r"^\s*\*\*\s?", "", body).strip()
                hits.append(Hit(isi, path, sl, sc, sl, "line"))
                if delete_mode:
                    spans_to_remove.append((i, end))
            i = end
            continue

        # 3) String literal (aman terhadap penutupan baris agar tidak membutakan sisa file)
        q = tok[0]
        if len(tok) == 3 and cfg["triple"]:
            end = text.find(tok, i + 3)
            i = n if end == -1 else end + 3
        else:
            j = i + 1
            while j < n:
                ch = text[j]
                if ch == "\\":
                    j += 2
                    continue
                if ch == q:
                    j += 1
                    break
                # Jika bukan backtick, atau jika backtick berada di dalam ekspresi satu baris yang mencurigakan,
                # batasi agar tidak menelan komentar /** di baris-baris berikutnya
                if ch == "\n":
                    if q != "`" or text[j + 1:j + 20].lstrip().startswith("/**"):
                        break
                j += 1
            i = j

    new_text = None
    if delete_mode and spans_to_remove:
        chunks = []
        last = 0
        for s_start, s_end in spans_to_remove:
            chunks.append(text[last:s_start])
            last = s_end
        chunks.append(text[last:])
        new_text = "".join(chunks)

    return hits, new_text


def looks_binary(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            return b"\0" in f.read(4096)
    except OSError:
        return True


def collect_files(root: str, rep: Reporter):
    root = os.path.abspath(root)
    self_path = os.path.abspath(__file__)
    files, n_dirs, n_skipped = [], 0, 0
    for dirpath, dirnames, filenames in os.walk(root):
        # Lewati semua SKIP_DIRS dan semua folder tersembunyi (termasuk .moriko)
        dirnames[:] = sorted(
            d for d in dirnames
            if d not in SKIP_DIRS and not d.startswith(".")
        )
        n_dirs += 1
        rep.show(f"[1/2] Menelusuri folder... {n_dirs} folder | {len(files)} file kode | "
                 f"{Reporter.tail(os.path.relpath(dirpath, root), 40)}")
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            if os.path.abspath(full) == self_path:
                continue
            cfg = HASH if name == "Dockerfile" else EXT_CONFIG.get(os.path.splitext(name)[1].lower())
            if cfg is None:
                continue
            try:
                size = os.path.getsize(full)
            except OSError:
                n_skipped += 1
                continue
            if size > MAX_FILE_BYTES:
                n_skipped += 1
                continue
            files.append((full, os.path.relpath(full, root), cfg, size))
    rep.show(f"[1/2] Penelusuran selesai: {n_dirs} folder, {len(files)} file kode ditemukan.", force=True)
    return files, n_dirs, n_skipped


def scan_workspace(root: str, only_block: bool, delete_mode: bool, rep: Reporter):
    files, _, n_skipped = collect_files(root, rep)
    total_bytes = sum(f[3] for f in files) or 1
    total_files = len(files)
    done_bytes, hits_all, modified_files, t_scan = 0, [], 0, time.monotonic()
    BAR = 24

    for idx, (full, rel, cfg, size) in enumerate(files, 1):
        pct = done_bytes / total_bytes
        filled = int(BAR * pct)
        spent = time.monotonic() - t_scan
        eta = f"ETA {fmt_time(spent * (1 - pct) / pct)}" if pct > 0.02 else "ETA ..."
        rep.show(f"[2/2] [{'#' * filled}{'-' * (BAR - filled)}] {pct * 100:3.0f}% "
                 f"({idx}/{total_files}) | {len(hits_all)} temuan | {fmt_time(spent)} | {eta} | "
                 f"{Reporter.tail(rel, 40)}", force=size > 100_000)
        if looks_binary(full):
            n_skipped += 1
            done_bytes += size
            continue
        try:
            with open(full, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
            file_hits, new_text = scan_text(text, cfg, rel, only_block, delete_mode)
            hits_all.extend(file_hits)
            if delete_mode and new_text is not None:
                with open(full, "w", encoding="utf-8", newline="") as f:
                    f.write(new_text)
                modified_files += 1
        except OSError:
            n_skipped += 1
        done_bytes += size

    aksi = f"dihapus dari {modified_files} file" if delete_mode else "ditemukan"
    rep.finish(f"[2/2] Selesai: {total_files} file dipindai ({n_skipped} dilewati) "
               f"dalam {fmt_time(rep.elapsed())} | {len(hits_all)} temuan ({aksi})")
    return hits_all


def location(h: Hit) -> str:
    if h.end_line != h.start_line:
        return f"baris {h.start_line}-{h.end_line} (kolom {h.start_col})"
    return f"baris {h.start_line}, kolom {h.start_col}"


def render(hits, fmt: str) -> str:
    rows = [(h.text, h.path, location(h)) for h in hits]
    head = ("Isi komentar", "Lokasi file", "Lokasi baris/posisi")

    if fmt == "json":
        return json.dumps(
            [dict(isi=h.text, file=h.path, baris_awal=h.start_line, kolom=h.start_col,
                  baris_akhir=h.end_line, jenis=h.kind) for h in hits],
            ensure_ascii=False, indent=2)

    if fmt == "csv":
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(head)
        w.writerows(rows)
        return buf.getvalue()

    if fmt == "md":
        esc = lambda s: s.replace("|", "\\|")
        out = ["| " + " | ".join(head) + " |", "| :--- | :--- | :--- |"]
        out += ["| " + " | ".join(esc(c) for c in r) + " |" for r in rows]
        return "\n".join(out)

    # Format table tanpa pemotongan dan tanpa padding ribuan spasi konyol
    out = [f"{head[0]} | {head[1]} | {head[2]}", "-" * 80]
    for a, b, c in rows:
        out.append(f"{a} | {b} | {c}")
    return "\n".join(out)


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass

    ap = argparse.ArgumentParser(description="Cari dan/atau hapus komentar bintang dua di workspace tanpa pemotongan.")
    ap.add_argument("--root", default=os.getcwd(), help="folder awal (default: folder saat ini)")
    ap.add_argument("--only-block", action="store_true", help="hanya komentar blok /** ... */")
    ap.add_argument("--hapus", action="store_true", help="langsung hapus semua komentar bintang dua yang ditemukan")
    ap.add_argument("--format", choices=["table", "md", "csv", "json"], default=None,
                    help="default: ikut ekstensi --out (.md/.csv/.json), selain itu table")
    ap.add_argument("--out", help="tulis hasil ke file ini")
    ap.add_argument("--no-progress", action="store_true", help="matikan tampilan progress")
    ap.add_argument("--progress", action="store_true", help="paksa progress walau stderr bukan terminal")
    args = ap.parse_args()

    fmt = args.format
    if fmt is None:
        ext = os.path.splitext(args.out or "")[1].lower()
        fmt = {".md": "md", ".csv": "csv", ".json": "json"}.get(ext, "table")

    enabled = not args.no_progress and (args.progress or sys.stderr.isatty())
    rep = Reporter(enabled)

    hits = scan_workspace(args.root, args.only_block, args.hapus, rep)
    result = render(hits, fmt)

    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="") as f:
            f.write(result + "\n")
        status = "dihapus dan dicatat" if args.hapus else "ditulis"
        print(f"{len(hits)} komentar bintang dua {status} ke {args.out}")
    else:
        print(result)
        print(f"\nTotal: {len(hits)} komentar bintang dua.", file=sys.stderr)


if __name__ == "__main__":
    main()