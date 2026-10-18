"""Parse the teacher's corrected facit PDFs into a structured glossary.

Each PDF is a Google Sheets export of one chapter: a table of numbered rows with
the columns  #  |  Svenska  |  Tolkspråk  |  Kommentarer.

The teacher marks up the students' Russian translations with colour:

* black text, left alone ...................... correct as written
* green text .................................. a good alternative, added
* struck-through text ......................... wrong; dropped
* blue text ................................... the teacher's correction
* (text in blue parentheses) .................. tolerable but not good

The Swedish cell's background colour (green / yellow / red) is carried through
as the term's status. The Kommentarer column is ignored.

Everything comes from geometry and colour in the PDF, not from the visual
rendering: characters carry their fill colour, strikethrough is a separate
line drawn across the middle of the struck characters, and table rows and
columns come from the drawn grid.

    python dictionary-web/tools/parse_facit.py            # writes build/glossary.json
    python dictionary-web/tools/parse_facit.py --review   # also writes build/review.txt
"""

from __future__ import annotations

import argparse
import colorsys
import json
import re
import sys
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import pymupdf

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SOURCE = ROOT / "src"
BUILD = ROOT / "build"

DOMAINS = (
    ("samhalle", "Samhälle", "samhälle"),
    ("sjukvard", "Sjukvård", "sjukvård"),
    ("migration", "Migration", "migration"),
    ("juridik", "Juridik", "juridik"),
)

# A strikethrough line sits across the middle of a glyph's box; table borders
# and underlines never do. Measured: 0.50 of the box height on these PDFs.
STRIKE_BAND = (0.28, 0.76)


# ----------------------------------------------------------------- colours


def text_colour(rgb: int) -> str:
    """Classify a text colour into the teacher's vocabulary.

    White counts as plain: some Swedish terms are written white on red cells
    so they stay legible.
    """

    r, g, b = (rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255
    if max(r, g, b) - min(r, g, b) < 40:
        return "plain"  # black, grey or white
    if g > r + 30 and g > b + 20:
        return "green"
    if b > r + 40 and b > g + 20:
        return "blue"
    return "other"


def fill_status(rgb: tuple[float, float, float]) -> str | None:
    """Term status from a cell fill or text highlight; None for white/grey."""

    h, s, v = colorsys.rgb_to_hsv(*rgb)
    if s < 0.2 or v < 0.3:
        return None
    hue = h * 360
    if hue < 20 or hue >= 340:
        return "red"
    if 40 <= hue < 75:
        return "yellow"
    if 75 <= hue < 170:
        return "green"
    return "other"


# --------------------------------------------------------------- geometry


@dataclass
class Char:
    c: str
    x0: float
    y0: float
    x1: float
    y1: float
    size: float
    colour: str
    struck: bool = False
    # Position of the run this glyph came from, and the glyph's index in the
    # content stream. Glyphs within a run keep stream order: sorting them by
    # x0 moved spaces whose boxes overlap the next letter ("döds fall" came
    # out as "dödsf all").
    run_x: float = 0.0
    order: int = 0

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2


@dataclass
class Fill:
    x0: float
    y0: float
    x1: float
    y1: float
    status: str


@dataclass
class PageGeometry:
    chars: list[Char]
    columns: list[float]  # five x positions: four columns
    rows: list[float]  # sorted y positions of horizontal grid lines
    fills: list[Fill]


def cluster(values: list[float], tolerance: float = 1.5) -> list[float]:
    groups: list[list[float]] = []
    for value in sorted(values):
        if groups and value - groups[-1][-1] <= tolerance:
            groups[-1].append(value)
        else:
            groups.append([value])
    return [sum(g) / len(g) for g in groups]


def read_page(page: pymupdf.Page) -> PageGeometry:
    strikes: list[tuple[float, float, float]] = []  # (y, x0, x1)
    verticals: list[float] = []
    horizontals: list[float] = []
    fills: list[Fill] = []

    for drawing in page.get_drawings():
        fill = drawing.get("fill")
        for item in drawing["items"]:
            kind = item[0]
            if kind == "l":
                p, q = item[1], item[2]
                if abs(p.x - q.x) < 0.6 and abs(p.y - q.y) > 8:
                    verticals.append(p.x)
                elif abs(p.y - q.y) < 0.6 and abs(p.x - q.x) > 2:
                    strikes.append((p.y, min(p.x, q.x), max(p.x, q.x)))
            elif kind == "re":
                rect = item[1]
                if rect.width < 1.5 and rect.height > 8:
                    verticals.append(rect.x0)
                elif rect.height < 1.5 and rect.width > 2:
                    strikes.append((rect.y0 + rect.height / 2, rect.x0, rect.x1))
        # Cell backgrounds and text highlights are filled paths, but not always
        # drawn as "re" items, so use the shape's overall bounds. Thin shapes
        # are rules and strikes, handled above.
        if fill is not None:
            box = drawing["rect"]
            status = fill_status(fill)
            if status and box.height >= 1.5 and box.width >= 1.5:
                fills.append(Fill(box.x0, box.y0, box.x1, box.y1, status))

    chars: list[Char] = []
    order = 0
    for block in page.get_text("rawdict")["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                colour = text_colour(span["color"])
                run_x = span["bbox"][0]
                for ch in span["chars"]:
                    order += 1
                    x0, y0, x1, y1 = ch["bbox"]
                    if x1 < x0 or y1 <= y0:
                        continue
                    chars.append(Char(ch["c"], x0, y0, x1, y1, span["size"], colour, run_x=run_x, order=order))

    for ch in chars:
        if ch.c.isspace():
            continue
        height = ch.y1 - ch.y0
        low, high = ch.y0 + STRIKE_BAND[0] * height, ch.y0 + STRIKE_BAND[1] * height
        for y, x0, x1 in strikes:
            if low <= y <= high and x0 - 0.5 <= ch.cx <= x1 + 0.5:
                ch.struck = True
                break

    # A row border runs from one column line to another; a strikethrough runs
    # across text and stops wherever the struck words end. Counting every long
    # horizontal line as a border let long strikes split one row into two.
    columns = cluster(verticals)
    def on_column(x: float) -> bool:
        return any(abs(x - c) <= 2.5 for c in columns)
    for y, x0, x1 in strikes:
        if on_column(x0) and on_column(x1):
            horizontals.append(y)

    return PageGeometry(
        chars=chars,
        columns=columns,
        rows=cluster(horizontals, tolerance=1.0),
        fills=fills,
    )


# ------------------------------------------------------------- cell text


@dataclass
class Glyph:
    c: str
    colour: str  # plain / green / blue / other / space
    struck: bool = False


def cell_glyphs(chars: list[Char]) -> list[Glyph]:
    """Reading-order glyphs for one cell, with spaces restored from gaps.

    The export writes words as separate runs and sometimes leaves the space out
    entirely, so spacing is recovered from the distance between glyphs.
    """

    if not chars:
        return []
    ordered = sorted(chars, key=lambda c: (c.cy, c.x0))
    lines: list[list[Char]] = []
    for ch in ordered:
        if lines and abs(ch.cy - lines[-1][0].cy) <= 0.45 * max(ch.size, 1):
            lines[-1].append(ch)
        else:
            lines.append([ch])

    glyphs: list[Glyph] = []
    for index, line in enumerate(sorted(lines, key=lambda l: l[0].cy)):
        line.sort(key=lambda c: (c.run_x, c.order))
        if index:
            # "оперативно-" + "розыскной" is one word the sheet wrapped at its
            # hyphen; joining with a space would split the compound.
            ends_hyphenated = len(glyphs) >= 2 and glyphs[-1].c == "-" and glyphs[-2].c.isalpha()
            first = next((c.c for c in line if not c.c.isspace()), "")
            if not (ends_hyphenated and first.islower()):
                glyphs.append(Glyph(" ", "space"))
        previous: Char | None = None
        for ch in line:
            if previous is not None and not ch.c.isspace() and not previous.c.isspace():
                if ch.x0 - previous.x1 > 0.18 * ch.size:
                    glyphs.append(Glyph(" ", "space"))
            glyphs.append(Glyph(" " if ch.c.isspace() else ch.c, "space" if ch.c.isspace() else ch.colour, ch.struck))
            previous = ch
    return glyphs


ZERO_WIDTH = dict.fromkeys(map(ord, "\u200b\u200c\u200d\u2060\ufeff\u00ad"), None)


def tidy(text: str) -> str:
    # The migration PDFs follow every row number with U+200B ZERO WIDTH SPACE,
    # which made "1.\u200b" fail to read as a row number at all.
    text = unicodedata.normalize("NFC", text).translate(ZERO_WIDTH)
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\s+([,.;:!?)\]»”])", r"\1", text)
    text = re.sub(r"([(\[«„])\s+", r"\1", text)
    text = re.sub(r"\s*/\s*", "/ ", text)  # the teacher writes "a/ b"; normalise it
    text = re.sub(r"\(\s*\)", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text.strip(" ,;/–-").strip()


# The students sign the rows they translated - "[Name 1-8]" in Kommentarer -
# and some also tagged individual translations: "мера (Name)", "саамы - Name X.",
# "[Имя: a note]". The names are learned from those signatures in the PDFs at
# run time rather than written here, so this file never carries them.
SIGNATURE = re.compile(r"\[\s*([A-ZÅÄÖ][a-zåäö]+)(?:\s+[A-ZÅÄÖ]\.)?\s+\d")
# A bracketed note opening with a Cyrillic name and a colon: "[Имя: …]".
CYRILLIC_NOTE = re.compile(r"\s*\[\s*[А-ЯЁ][а-яё]+\s*:[^\]]*\]")
ATTRIBUTION: tuple[re.Pattern[str], ...] = (CYRILLIC_NOTE,)


def learn_signatures(paths: list[Path]) -> set[str]:
    """First names the students signed their rows with, across all PDFs."""

    names: set[str] = set()
    for path in paths:
        for page in pymupdf.open(path):
            text = unicodedata.normalize("NFC", page.get_text("text")).translate(ZERO_WIDTH)
            names.update(SIGNATURE.findall(text))
    return names


def use_signatures(names: set[str]) -> None:
    global ATTRIBUTION
    if not names:
        ATTRIBUTION = (CYRILLIC_NOTE,)
        return
    who = "(?:" + "|".join(sorted(map(re.escape, names), key=len, reverse=True)) + ")"
    ATTRIBUTION = (
        CYRILLIC_NOTE,
        re.compile(rf"\s*\[\s*{who}\b[^\]]*\]"),  # [Name: a note]
        re.compile(rf"\s*\(\s*{who}(?:\s+[A-ZА-Я]\.)?\s*\)\s*$"),  # (Name)
        re.compile(rf"\s*[-–]\s*{who}(?:\s+[A-ZА-Я]\.)?\s*$"),  # - Name X.
    )


def strip_attribution(text: str) -> str:
    for pattern in ATTRIBUTION:
        text = pattern.sub("", text)
    return tidy(text)


def plain_text(glyphs: list[Glyph]) -> str:
    return tidy("".join(g.c for g in glyphs if not g.struck))


@dataclass
class Translation:
    text: str
    kind: str  # "correct" or "acceptable"
    origin: str  # original / alternative / correction / mixed


def parse_translations(glyphs: list[Glyph]) -> tuple[list[Translation], str]:
    """Apply the teacher's markup rules to one Tolkspråk cell.

    Returns the translations and the struck-out text that was dropped (kept
    only for the review report).
    """

    dropped = tidy("".join(g.c if g.struck else " " for g in glyphs))
    live = [g for g in glyphs if not g.struck]

    # Blue parentheses around non-blue text mark a tolerable translation.
    tolerable = [False] * len(live)
    stack: list[int] = []
    for index, glyph in enumerate(live):
        if glyph.c == "(":
            stack.append(index)
        elif glyph.c == ")" and stack:
            start = stack.pop()
            if live[start].colour == "blue" and glyph.colour == "blue":
                inner = [g for g in live[start + 1 : index] if g.colour != "space"]
                if inner and sum(g.colour == "blue" for g in inner) < len(inner) / 2:
                    for k in range(start, index + 1):
                        tolerable[k] = True

    # Alternatives are separated by top-level semicolons, whatever their colour.
    pieces: list[list[int]] = [[]]
    depth = 0
    for index, glyph in enumerate(live):
        if glyph.c == "(":
            depth += 1
        elif glyph.c == ")":
            depth = max(0, depth - 1)
        if glyph.c == ";" and depth == 0:
            pieces.append([])
        else:
            pieces[-1].append(index)

    results: list[Translation] = []
    for indices in pieces:
        visible = [i for i in indices if live[i].colour != "space"]
        if not visible:
            continue
        all_tolerable = all(tolerable[i] for i in visible)
        if all_tolerable:
            inner = [i for i in indices if not (live[i].c in "()" and live[i].colour == "blue")]
            text = tidy("".join(live[i].c for i in inner))
            kind = "acceptable"
        else:
            text = tidy("".join(live[i].c for i in indices))
            kind = "correct"
        text = strip_attribution(text)
        if not text or not re.search(r"\w", text):
            continue
        colours = Counter(live[i].colour for i in visible if live[i].c.isalnum())
        if not colours:
            origin = "original"
        elif colours.keys() <= {"plain", "other"}:
            origin = "original"
        elif colours.keys() == {"green"}:
            origin = "alternative"
        elif colours.keys() == {"blue"}:
            origin = "correction"
        else:
            origin = "mixed"
        results.append(Translation(text, kind, origin))
    return results, dropped


# --------------------------------------------------------------- documents


@dataclass
class Term:
    n: int | None  # None for a section heading that carries a translation
    sv: str
    status: str | None
    translations: list[Translation]
    section: str | None
    dropped: str = ""
    page: int = 0
    glyphs: list[Glyph] = field(default_factory=list, repr=False)


@dataclass
class Chapter:
    domain: str
    key: str
    number: int | None
    title: str
    source: str
    terms: list[Term] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    untranslated: list[str] = field(default_factory=list)  # in the source, not our loss
    notes: list[str] = field(default_factory=list)
    source_rows: int = 0


HEADER_WORDS = {"svenska", "tolkspråk", "kommentarer", "kommentar", "ryska", "nr", "#"}
CYRILLIC = re.compile(r"[\u0400-\u04ff]")
NUMBER = re.compile(r"^(\d{1,3})\.?$")


def chapter_identity(filename: str) -> tuple[str, str, int | None]:
    name = unicodedata.normalize("NFC", filename)
    domain = next((d for d, _label, token in DOMAINS if f" {token} " in f" {name} "), None)
    if domain is None:
        raise ValueError(f"no domain in {filename!r}")
    match = re.search(r"kap\.\s*(\d+)", name)
    if match:
        return domain, match.group(1), int(match.group(1))
    word = re.search(r"Facit\s+(\w+)", name)
    key = word.group(1).lower() if word else name
    return domain, key, None


PROPER_NOUNS = {"sverige": "Sverige", "sveriges": "Sveriges", "eu": "EU", "eu:s": "EU:s"}


def clean_title(title: str) -> str:
    title = re.sub(r",?\s*sid\.?\s*\d+\s*[-–]\s*\d+\s*$", "", title, flags=re.IGNORECASE)
    title = re.sub(r"\s*\d{4}-\d{2}-\d{2}\s*$", "", title)  # "Juridik 2023-03-13"
    title = re.sub(r"\s+", " ", title).strip(" ,:")
    if title.isupper():
        # The sjukvård sheets shout their titles; sentence case reads better in
        # a picker, but must not lowercase "Sverige".
        words = title.capitalize().split(" ")
        title = " ".join(PROPER_NOUNS.get(w.lower(), w) for w in words)
    return title


def chapter_title(lines: list[str], key: str, number: int | None) -> str:
    for line in lines:
        match = re.match(r"^\s*kapitel\s+(\d+)\s*[:.\-–]?\s*(.+)$", line, re.IGNORECASE)
        if match and (number is None or int(match.group(1)) == number):
            title = clean_title(match.group(2))
            if title:
                return title
    for line in lines:
        match = re.match(r"^\s*terminologi\s*[–-]\s*(.+)$", line, re.IGNORECASE)
        if match:
            return clean_title(match.group(1))
    # No "Kapitel N" line (sjukvård 14): the title is the first real line that
    # is neither the textbook credit nor the table header.
    for line in lines:
        if len(line) < 3 or re.search(r"gillå|medicin\s*1|källa|terminologilistor|framtagna", line, re.IGNORECASE):
            continue
        if line.strip(":").lower() in HEADER_WORDS:
            break
        return clean_title(line)
    return key.capitalize()


def page_lines(geometry: PageGeometry) -> list[str]:
    return [line for line in plain_text(cell_glyphs(geometry.chars)).split("  ")]


def text_lines(page: pymupdf.Page) -> list[str]:
    return [l.strip() for l in page.get_text("text").splitlines() if l.strip()]


def status_for(cell_chars: list[Char], fills: list[Fill], band: tuple[float, float], col: tuple[float, float]) -> str | None:
    """The fill behind the Swedish term: full-cell background or text highlight."""

    if cell_chars:
        x0 = min(c.x0 for c in cell_chars)
        x1 = max(c.x1 for c in cell_chars)
        y0 = min(c.y0 for c in cell_chars)
        y1 = max(c.y1 for c in cell_chars)
    else:
        x0, x1, y0, y1 = col[0], col[1], band[0], band[1]
    best: tuple[float, str] | None = None
    for fill in fills:
        w = min(x1, fill.x1) - max(x0, fill.x0)
        h = min(y1, fill.y1) - max(y0, fill.y0)
        if w <= 0 or h <= 0:
            continue
        # Ignore fills that cover the whole row width: those are section rows.
        if fill.x0 < col[0] - 5 and fill.x1 > col[1] + 100:
            continue
        area = w * h
        if best is None or area > best[0]:
            best = (area, fill.status)
    return best[1] if best else None


def parse_document(path: Path) -> Chapter:
    domain, key, number = chapter_identity(path.name)
    doc = pymupdf.open(path)
    chapter = Chapter(domain, key, number, "", unicodedata.normalize("NFC", path.name))

    first_lines = text_lines(doc[0])
    chapter.title = chapter_title(first_lines, key, number)

    section: str | None = None
    columns: list[float] | None = None
    last_term: Term | None = None

    for page_index, page in enumerate(doc):
        geometry = read_page(page)
        if len(geometry.columns) == 5:
            columns = geometry.columns
        elif geometry.chars and any(not c.c.isspace() for c in geometry.chars):
            if columns is None:
                chapter.warnings.append(f"page {page_index + 1}: no table grid and no earlier one to reuse")
                continue
            chapter.warnings.append(f"page {page_index + 1}: no grid, reused previous columns")
        else:
            continue
        assert columns is not None

        bounds = list(zip(columns, columns[1:]))
        rows = geometry.rows
        if len(rows) < 2:
            continue
        for top, bottom in zip(rows, rows[1:]):
            if bottom - top < 4:
                continue
            band = [c for c in geometry.chars if top < c.cy < bottom]
            if not band:
                continue

            def column(i: int) -> list[Char]:
                left, right = bounds[i]
                return [c for c in band if left < c.cx < right]

            number_text = plain_text(cell_glyphs(column(0)))
            sv_chars = column(1)
            ru_chars = column(2)
            sv_text = plain_text(cell_glyphs(sv_chars))
            ru_glyphs = cell_glyphs(ru_chars)

            match = NUMBER.match(number_text)
            has_russian = bool(CYRILLIC.search("".join(g.c for g in ru_glyphs if not g.struck)))
            status = status_for(sv_chars, geometry.fills, (top, bottom), bounds[1])

            if not match:
                whole = plain_text(cell_glyphs(band))
                words = {w.strip(":").lower() for w in whole.split()}
                if not whole or words <= HEADER_WORDS:
                    continue  # empty band or a repeated header row
                if re.match(r"^\s*kapitel\s+\d+", whole, re.IGNORECASE):
                    continue  # chapter title row inside the table
                if sv_text and has_russian:
                    # A section heading that the students translated too
                    # ("Örat" - "ухо"): real vocabulary, and the section name
                    # for the rows below it.
                    section = sv_text
                    translations, dropped = parse_translations(ru_glyphs)
                    term = Term(None, sv_text, status, translations, section, dropped, page_index + 1, ru_glyphs)
                    chapter.terms.append(term)
                    last_term = term
                    continue
                if has_russian and not sv_text and last_term is not None:
                    # The export split one row across a page break, sometimes
                    # mid-sentence, so the halves are joined and parsed as one
                    # cell rather than kept as two translations.
                    last_term.glyphs = last_term.glyphs + [Glyph(" ", "space")] + ru_glyphs
                    last_term.translations, last_term.dropped = parse_translations(last_term.glyphs)
                    chapter.notes.append(f"page {page_index + 1}: joined a row split across pages onto #{last_term.n}")
                    continue
                if not has_russian:
                    section = whole
                    continue
                chapter.warnings.append(f"page {page_index + 1}: unnumbered row skipped: {whole[:70]!r}")
                continue

            chapter.source_rows += 1
            if sv_text.strip(":").lower() in HEADER_WORDS:
                continue  # samhälle 8-17 number their header row "1"
            if not sv_text and not has_russian:
                continue  # an empty numbered row in the sheet
            if not has_russian:
                if status is None:
                    section = sv_text  # a heading that happens to carry a number
                else:
                    chapter.untranslated.append(f"#{match.group(1)} {sv_text}")
                continue

            translations, dropped = parse_translations(ru_glyphs)
            term = Term(
                n=int(match.group(1)),
                sv=sv_text,
                status=status,
                translations=translations,
                section=section,
                dropped=dropped,
                page=page_index + 1,
                glyphs=ru_glyphs,
            )
            chapter.terms.append(term)
            last_term = term

    # Integrity, counted independently of the row parser: every number token
    # in the first column of the source is one numbered row, so the parser
    # must have visited exactly that many. Numbering itself is not checked:
    # the sheets genuinely skip and repeat numbers (samhälle 14 starts at 2).
    expected = 0
    for page in doc:
        geometry = read_page(page)
        if len(geometry.columns) != 5:
            continue
        left, right = geometry.columns[0], geometry.columns[1]
        for word in page.get_text("words"):
            token = word[4].translate(ZERO_WIDTH)
            if NUMBER.match(token) and left < (word[0] + word[2]) / 2 < right and len(geometry.rows) > 1:
                if geometry.rows[0] < (word[1] + word[3]) / 2 < geometry.rows[-1]:
                    expected += 1
    if expected != chapter.source_rows:
        chapter.warnings.append(f"source has {expected} numbered rows, parser visited {chapter.source_rows}")

    for term in chapter.terms:
        if not term.sv:
            chapter.warnings.append(f"#{term.n}: empty Swedish term")
        if not term.translations:
            chapter.warnings.append(f"#{term.n} {term.sv!r}: no translation survived")
        elif all(t.kind == "acceptable" for t in term.translations):
            chapter.warnings.append(f"#{term.n} {term.sv!r}: only tolerable translations")
        if term.n is not None and term.status not in ("green", "yellow", "red"):
            chapter.warnings.append(f"#{term.n} {term.sv!r}: no colour status ({term.status})")
    return chapter


# ------------------------------------------------------------------ output


def chapter_sort_key(chapter: Chapter) -> tuple[int, str]:
    return (chapter.number if chapter.number is not None else 10_000, chapter.key)


def build(source: Path) -> list[Chapter]:
    paths = sorted(source.glob("*.pdf"))
    if not paths:
        raise SystemExit(f"no PDFs in {source}")
    use_signatures(learn_signatures(paths))
    return [parse_document(p) for p in paths]


def to_json(chapters: list[Chapter]) -> dict:
    dictionaries = []
    for domain, label, _token in DOMAINS:
        items = sorted((c for c in chapters if c.domain == domain), key=chapter_sort_key)
        dictionaries.append(
            {
                "id": domain,
                "name": label,
                "chapters": [
                    {
                        "id": c.key,
                        "number": c.number,
                        "title": c.title,
                        "source": c.source,
                        "terms": [
                            {
                                "n": t.n,
                                "sv": t.sv,
                                "status": t.status,
                                "section": t.section,
                                "ru": [x.text for x in t.translations if x.kind == "correct"],
                                "ru_acceptable": [x.text for x in t.translations if x.kind == "acceptable"],
                            }
                            for t in c.terms
                        ],
                    }
                    for c in items
                ],
            }
        )
    return {"version": 2, "dictionaries": dictionaries}


def review(chapters: list[Chapter]) -> str:
    out: list[str] = []
    for chapter in sorted(chapters, key=lambda c: ([d for d, *_ in DOMAINS].index(c.domain), chapter_sort_key(c))):
        out.append(f"\n=== {chapter.domain} / {chapter.key}: {chapter.title}  ({len(chapter.terms)} terms)  [{chapter.source}]")
        for w in chapter.warnings:
            out.append(f"  ! {w}")
        for n in chapter.notes:
            out.append(f"  i {n}")
        for u in chapter.untranslated:
            out.append(f"  ? untranslated in source: {u}")
        for t in chapter.terms:
            good = " ; ".join(f"{x.text}" + ("" if x.origin == "original" else f" <{x.origin}>") for x in t.translations if x.kind == "correct")
            weak = " ; ".join(x.text for x in t.translations if x.kind == "acceptable")
            number = "  -" if t.n is None else f"{t.n:>3}"
            line = f"  {number} [{(t.status or '-')[:1].upper()}] {t.sv} => {good}"
            if weak:
                line += f"   (TOLERABLE: {weak})"
            if t.dropped:
                line += f"   ~~{t.dropped}~~"
            out.append(line)
    return "\n".join(out)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--review", action="store_true", help="also write build/review.txt")
    args = parser.parse_args()

    chapters = build(args.source)
    BUILD.mkdir(exist_ok=True)
    data = to_json(chapters)
    (BUILD / "glossary.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    if args.review:
        (BUILD / "review.txt").write_text(review(chapters), encoding="utf-8")

    terms = sum(len(c.terms) for c in chapters)
    warnings = sum(len(c.warnings) for c in chapters)
    for d in data["dictionaries"]:
        n = sum(len(c["terms"]) for c in d["chapters"])
        print(f"  {d['name']:10} {len(d['chapters']):2} chapters  {n:5} terms")
    print(f"{len(chapters)} PDFs, {terms} terms, {warnings} warnings -> {BUILD / 'glossary.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
