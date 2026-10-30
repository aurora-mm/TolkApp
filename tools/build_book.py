"""Typeset the glossary as a printed dictionary.

Reads build/glossary.json and writes, to build/book/:

* all.pdf - the whole book, one part per course
* <course>.pdf - each course on its own
* manifest.json - what encrypt-dictionary.mjs needs to seal them for the site

Each part runs both ways, Swedish-Russian then Russian-Swedish, in the correct
alphabetical order for its language, in two columns with guide words in the
running heads. Every finished PDF is read back and checked: all terms and
translations must be present, nothing may fall outside the margins, and the
font must have had every character.

Needs XeLaTeX with fontspec, polyglossia, multicol and fancyhdr, plus the
PT Serif font (included with macOS; free under the SIL Open Font License) and
pymupdf for the check.

    python tools/build_book.py            # every book
    python tools/build_book.py juridik    # one course, for a quick look

The PDFs are readable without the password, so build/ must never be published.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
GLOSSARY = ROOT / "build" / "glossary.json"
OUTPUT = ROOT / "build" / "book"

MONTHS = "januari februari mars april maj juni juli augusti september oktober november december".split()
STATUS_CODE = {"green": "g", "yellow": "y", "red": "r"}
GREENNESS = {"green": 0, "yellow": 1, "red": 2, None: 3}


# ---------------------------------------------------------------- collation

# Swedish files å ä ö after z, Russian е and ё together, and neither alphabet
# matches the order of the Unicode tables on its own.
ALPHABET = "0123456789" + "abcdefghijklmnopqrstuvwxyzåäö" + "абвгдежзийклмнопрстуфхцчшщъыьэюя"
RANK = {letter: index for index, letter in enumerate(ALPHABET)}
FOLD = {"ё": "е", "é": "e", "è": "e", "ê": "e", "ü": "y", "à": "a", "á": "a", "æ": "ä", "ø": "ö", "ß": "ss"}


def sort_letters(text: str) -> str:
    """The letters a term files under.

    Dictionaries file letter by letter, ignoring spaces and punctuation. A
    leading optional word is skipped too: "(денежное) требование" is looked for
    under т.
    """

    folded = unicodedata.normalize("NFC", text).casefold()
    bare = re.sub(r"^\s*\([^)]*\)\s*", "", folded) or folded
    letters = "".join(FOLD.get(ch, ch) for ch in bare)
    return "".join(ch for ch in letters if ch in RANK)


def sort_key(text: str) -> tuple:
    return ([RANK[ch] for ch in sort_letters(text)], text.casefold(), text)


def initial(text: str) -> str:
    """The letter heading a term sits under."""

    letters = sort_letters(text)
    if not letters:
        return "#"
    first = letters[0]
    if first.isdigit():
        return "0–9"
    return first.upper()


def group_rank(heading: str) -> int:
    return -1 if heading in ("#", "0–9") else RANK[heading.lower()]


# ------------------------------------------------------------------ entries


@dataclass
class Swedish:
    """A Swedish headword, merged across the chapters it appears in."""

    term: str
    status: str | None
    correct: list[str] = field(default_factory=list)
    tolerable: list[str] = field(default_factory=list)
    chapters: list[str] = field(default_factory=list)


@dataclass
class Russian:
    """A Russian headword and every Swedish term it translates."""

    term: str
    swedish: dict[str, str | None] = field(default_factory=dict)
    chapters: list[str] = field(default_factory=list)
    tolerable: bool = True  # stays true only if never listed as correct


def chapter_label(chapter: dict) -> str:
    return str(chapter["number"]) if chapter["number"] is not None else "Psyk."


def add_once(items: list[str], value: str) -> None:
    if not any(item.casefold() == value.casefold() for item in items):
        items.append(value)


def build_entries(course: dict) -> tuple[list[Swedish], list[Russian]]:
    swedish: dict[str, Swedish] = {}
    russian: dict[str, Russian] = {}
    for chapter in course["chapters"]:
        label = chapter_label(chapter)
        for term in chapter["terms"]:
            entry = swedish.setdefault(term["sv"].casefold(), Swedish(term["sv"], term["status"]))
            if GREENNESS[term["status"]] < GREENNESS[entry.status]:
                entry.status = term["status"]
            for text in term["ru"]:
                add_once(entry.correct, text)
            for text in term["ru_acceptable"]:
                add_once(entry.tolerable, text)
            add_once(entry.chapters, label)

            for text, tolerable in [(t, False) for t in term["ru"]] + [(t, True) for t in term["ru_acceptable"]]:
                reverse = russian.setdefault(text.casefold(), Russian(text))
                known = reverse.swedish.get(term["sv"], "absent")
                if known == "absent" or GREENNESS[term["status"]] < GREENNESS[known]:
                    reverse.swedish[term["sv"]] = term["status"]
                add_once(reverse.chapters, label)
                if not tolerable:
                    reverse.tolerable = False

    for entry in swedish.values():
        # Tolerable in one chapter but correct in another: it is correct.
        entry.tolerable = [t for t in entry.tolerable if not any(c.casefold() == t.casefold() for c in entry.correct)]
    return (
        sorted(swedish.values(), key=lambda e: sort_key(e.term)),
        sorted(russian.values(), key=lambda e: sort_key(e.term)),
    )


# -------------------------------------------------------------------- LaTeX

TEX_SPECIAL = {
    "\\": r"\textbackslash{}", "{": r"\{", "}": r"\}", "$": r"\$", "&": r"\&", "#": r"\#",
    "%": r"\%", "_": r"\_", "^": r"\textasciicircum{}", "~": r"\textasciitilde{}",
}


def tex(text: str) -> str:
    return "".join(TEX_SPECIAL.get(ch, ch) for ch in text)


def flow(text: str) -> str:
    """Escaped text in which long compounds can still break.

    TeX will not hyphenate inside a word that already has a hyphen, so
    "административно-процессуальный" overran the column. Skips on both sides
    make each half an ordinary word; the penalty stops a line starting with
    the hyphen itself.
    """

    return re.sub(r"(?<=\w)-(?=\w)", r"\\nobreak\\hskip0pt-\\hskip0pt ", tex(text))


def flow_ru(text: str) -> str:
    """As flow(), for Russian text that may quote long Swedish words.

    "(аналог: kontraheringsplikt)": Russian hyphenation patterns cannot split
    a Latin word, so those are hyphenated as Swedish.
    """

    return re.sub(r"[A-Za-zÅÄÖåäöÉé]{8,}", lambda m: rf"\Sv{{{m.group()}}}", flow(text))


def split_head(term: str) -> tuple[str, str]:
    """The bold part of a headword and any trailing explanation in brackets.

    "двоемужие (Лицо состоит в браке …)" is a headword and a gloss; only the
    headword belongs in bold.
    """

    match = re.match(r"^(.+?)(\s+\(.*)$", term, re.DOTALL)
    return (match.group(1), match.group(2)) if match else (term, "")


def guide_word(term: str) -> str:
    """A short form for the running head."""

    head = re.sub(r"^\s*\([^)]*\)\s*", "", term) or term
    words: list[str] = []
    for word in head.split():
        if words and len(" ".join(words + [word])) > 24:
            break
        words.append(word)
    return " ".join(words).strip(" ,;:/()\"“”«»")[:30]


def dot(status: str | None) -> str:
    code = STATUS_CODE.get(status)
    return rf"\Dot{code}{{}}" if code else ""


def refs(chapters: list[str]) -> str:
    return ", ".join(sorted(chapters, key=lambda c: (not c.isdigit(), int(c) if c.isdigit() else 0)))


def swedish_entry(entry: Swedish) -> str:
    head, gloss = split_head(entry.term)
    body = "; ".join(flow_ru(t) for t in entry.correct)
    if entry.tolerable:
        loose = "; ".join(flow_ru(t) for t in entry.tolerable)
        body = f"{body} " if body else ""
        body += rf"\Alt{{({loose})}}"
    return (
        rf"\Ent{{{dot(entry.status)}\Hd{{{flow(head)}}}{flow(gloss)}}}"
        rf"{{\Ru{{{body}}}}}{{{tex(refs(entry.chapters))}}}{{{tex(guide_word(entry.term))}}}"
    )


def russian_entry(entry: Russian) -> str:
    head, gloss = split_head(entry.term)
    shown = rf"\Alt{{{flow_ru(entry.term)}}}" if entry.tolerable else rf"\Hd{{{flow_ru(head)}}}{flow_ru(gloss)}"
    body = "; ".join(rf"{dot(status)}{flow(term)}" for term, status in entry.swedish.items())
    return rf"\Ent{{\Ru{{{shown}}}}}{{{body}}}{{{tex(refs(entry.chapters))}}}{{{tex(guide_word(entry.term))}}}"


def section(entries: list, render, slug: str) -> str:
    groups: dict[str, list[str]] = {}
    for entry in entries:
        groups.setdefault(initial(entry.term), []).append(render(entry))
    out: list[str] = []
    for heading in sorted(groups, key=group_rank):
        anchor = heading if heading.isalnum() else "num"
        out.append(rf"\Let{{{tex(heading)}}}{{{slug}-{anchor}}}")
        out.extend(groups[heading])
    return "\n".join(out)


PREAMBLE = r"""
\documentclass[10pt,a4paper,twoside,openright]{book}
\usepackage[inner=20mm,outer=15mm,top=25mm,bottom=20mm,headsep=8mm,footskip=9mm]{geometry}
\usepackage{fontspec}
\defaultfontfeatures[\rmfamily]{Ligatures=Common}
\setmainfont{PT Serif}
\usepackage{polyglossia}
\setdefaultlanguage{swedish}
\setotherlanguage{russian}
\newfontfamily\cyrillicfont{PT Serif}
\usepackage{multicol,fancyhdr,xcolor,array}
\usepackage[hidelinks,bookmarksnumbered=false,bookmarksdepth=2]{hyperref}
\hypersetup{pdftitle={Tolkstöd – Ordbok för tolkar},pdfsubject={Svensk-rysk och rysk-svensk ordbok},pdflang={sv}}

\definecolor{tgreen}{HTML}{3F9B2A}
\definecolor{tyellow}{HTML}{D9A900}
\definecolor{tred}{HTML}{D92D20}
\definecolor{tgrey}{HTML}{6B7280}
\definecolor{trule}{HTML}{C9CED6}

% Hyphenation follows each language without switching fonts or shorthands,
% which matters at this many language changes.
\makeatletter
\newcommand\Ru[1]{{\language\l@russian\lefthyphenmin=2\righthyphenmin=2 #1}}
\makeatother
\makeatletter
\newcommand\Sv[1]{{\language\l@swedish\lefthyphenmin=2\righthyphenmin=2 #1}}
\makeatother
\newcommand\Hd[1]{\textbf{#1}}
\newcommand\Alt[1]{{\itshape\color{tgrey}#1}}
% The penalty keeps a dot with its word; the skip still lets the word hyphenate.
\newcommand\Mark[1]{\textcolor{#1}{\raisebox{0.05ex}{\footnotesize\textbullet}}\,\nobreak\hskip0pt}
\newcommand\Dotg{\Mark{tgreen}}
\newcommand\Doty{\Mark{tyellow}}
\newcommand\Dotr{\Mark{tred}}

% \Ent{headword}{translations}{chapters}{guide word}
\newcommand\Ent[4]{%
  \par
  % TeX never hyphenates a paragraph's first word, and here that word is the
  % headword; the empty skip makes it an ordinary word that can break. The mark
  % goes inside the paragraph: between paragraphs, a page break could leave it
  % behind, and the running head would be one entry out.
  \hangindent=0.9em\hangafter=1\noindent\hskip0pt\markboth{#4}{#4}#1\hskip 0.5em plus 0.15em\relax #2%
  \unskip\enspace{\scriptsize\color{tgrey}#3}\par}

\newcounter{letteranchor}
\newcommand\Let[2]{%
  \par\addvspace{7pt plus 3pt}%
  \pdfbookmark[2]{#1}{#2}%
  {\centering\color{tgrey}\rule[0.6ex]{1.6em}{0.3pt}\quad
   \textcolor{black}{\bfseries\large #1}\quad\rule[0.6ex]{1.6em}{0.3pt}\par}%
  \nobreak\vskip 3pt\nobreak}

\setlength{\columnsep}{7mm}
\setlength{\columnseprule}{0.25pt}
\renewcommand{\columnseprulecolor}{\color{trule}}
\setlength{\parindent}{0pt}
\setlength{\parskip}{1.1pt plus 0.5pt}
\tolerance=3000
\emergencystretch=2.2em
\clubpenalty=10000
\widowpenalty=10000
\interlinepenalty=150
\raggedcolumns

% Guide words: \leftmark is the last headword on the page, \rightmark the first.
\newcommand\CurrentSection{}
\newcommand\GuideRange{%
  \edef\first{\rightmark}\edef\last{\leftmark}%
  \ifx\first\empty\else\ifx\first\last\first\else\first\ –\ \last\fi\fi}
\pagestyle{fancy}
\fancyhf{}
\fancyhead[LE,RO]{\small\bfseries\GuideRange}
\fancyhead[RE,LO]{\footnotesize\color{tgrey}\CurrentSection}
\fancyfoot[C]{\footnotesize\thepage}
\renewcommand{\headrulewidth}{0.3pt}
\renewcommand{\headrule}{{\color{trule}\hrule height 0.3pt}}
\setlength{\headheight}{13pt}
\fancypagestyle{plain}{\fancyhf{}\fancyfoot[C]{\footnotesize\thepage}\renewcommand{\headrulewidth}{0pt}\renewcommand{\headrule}{}}
\fancypagestyle{bare}{\fancyhf{}\renewcommand{\headrulewidth}{0pt}\renewcommand{\headrule}{}}

% Blank left-hand pages before a new part carry no head or number.
\makeatletter
\renewcommand{\cleardoublepage}{\clearpage\if@twoside\ifodd\c@page\else
  \thispagestyle{bare}\hbox{}\newpage\fi\fi}
\makeatother

\newcommand\PartOpener[3]{%
  \cleardoublepage\thispagestyle{bare}%
  \phantomsection\addcontentsline{toc}{chapter}{#1}%
  \vspace*{34mm}%
  {\fontsize{32}{38}\selectfont\bfseries #1\par}\vspace{3mm}%
  {\large\color{tgrey}#2\par}\vspace{11mm}%
  #3%
  \clearpage}

% {course}{title}{count}{plain title for the PDF sidebar}
\newcommand\Direction[4]{%
  \renewcommand\CurrentSection{#1 · #2}%
  \cleardoublepage\markboth{}{}%
  \thispagestyle{plain}%
  \phantomsection\addcontentsline{toc}{section}{\texorpdfstring{#2}{#4}}%
  \begin{multicols}{2}[\DirectionHead{#2}{#3}]%
  \fontsize{8.7}{10.7}\selectfont}
\newcommand\DirectionHead[2]{{\centering{\Large\bfseries #1\par}\vspace{1.5mm}{\small\color{tgrey}#2\par}\vspace{5mm}}}
\newcommand\EndDirection{\end{multicols}}
"""


def chapter_table(course: dict) -> str:
    rows = []
    for chapter in course["chapters"]:
        rows.append(rf"{tex(chapter_label(chapter))} & {tex(chapter['title'])} \\")
    return (
        r"{\small\color{tgrey}Siffrorna efter varje ord hänvisar till kapitlen:\par}\vspace{3mm}"
        r"{\small\renewcommand{\arraystretch}{1.22}\begin{tabular}{@{}>{\raggedleft\arraybackslash}p{9mm}@{\quad}p{135mm}@{}}"
        + "\n".join(rows)
        + r"\end{tabular}\par}"
    )


def plural_terms(count: int) -> str:
    return f"{count:,}".replace(",", " ") + " termer"


def front_matter(title: str, courses_line: str, total: int) -> str:
    today = date.today()
    return rf"""
\begin{{titlepage}}
\centering
\vspace*{{58mm}}
{{\fontsize{{46}}{{52}}\selectfont\bfseries Tolkstöd\par}}
\vspace{{7mm}}
{{\LARGE {tex(title)}\par}}
\vspace{{3mm}}
{{\Large\color{{tgrey}}\Ru{{Шведско-русский и русско-шведский словарь}}\par}}
\vspace{{16mm}}
{{\large {tex(courses_line)}\par}}
\vfill
{{\color{{tgrey}}{plural_terms(total)}\par\vspace{{1mm}}{MONTHS[today.month - 1]} {today.year}\par}}
\end{{titlepage}}
\cleardoublepage
\thispagestyle{{bare}}
\begin{{center}}{{\Large\bfseries Innehåll\par}}\end{{center}}
\vspace{{4mm}}
\makeatletter\@starttoc{{toc}}\makeatother
\vspace{{14mm}}
{{\large\bfseries Så läser du ordboken\par}}\vspace{{2mm}}
Varje kurs står för sig, först svensk-rysk och sedan rysk-svensk. Svenska ord står i svensk
bokstavsordning, med å, ä och ö sist, och ryska ord i rysk. Ord som står i parentes först, till
exempel \Ru{{(денежное) требование}}, sorteras efter det ord som följer.\par\vspace{{2mm}}
\Dotg\Doty\Dotr\ Pricken före ett svenskt ord är ordets färgmarkering i kursmaterialet: grön, gul
eller röd. Ord utan prick är omarkerade.\par\vspace{{2mm}}
\Alt{{(Kursivt i parentes)}} är en översättning som är godtagbar men inte särskilt bra.\par\vspace{{2mm}}
De små siffrorna sist hänvisar till kursens kapitel.\par\vspace{{7mm}}
\Ru{{{{\large\bfseries Как пользоваться словарём\par}}\vspace{{2mm}}
Каждый курс идёт отдельно: сначала шведско-русская часть, затем русско-шведская. Цветная точка перед
шведским словом — его отметка в учебных материалах (зелёная, жёлтая или красная). \Alt{{Курсивом в скобках}}
дан допустимый, но не лучший перевод. Маленькие цифры в конце — номера глав курса.\par}}
\clearpage
"""


def document(courses: list[dict], title: str, courses_line: str) -> tuple[str, dict[str, tuple[list, list]]]:
    entries = {course["id"]: build_entries(course) for course in courses}
    total = sum(len(entries[c["id"]][0]) for c in courses)
    body = [PREAMBLE, r"\setcounter{tocdepth}{1}", r"\begin{document}", front_matter(title, courses_line, total)]
    for course in courses:
        swedish, russian = entries[course["id"]]
        name = tex(course["name"])
        chapters = len(course["chapters"])
        body.append(rf"\PartOpener{{{name}}}{{{plural_terms(len(swedish))} · {chapters} kapitel}}{{{chapter_table(course)}}}")
        body.append(rf"\Direction{{{name}}}{{Svenska – ryska}}{{{plural_terms(len(swedish))}}}{{Svenska – ryska}}")
        body.append(section(swedish, swedish_entry, f"{course['id']}-sv"))
        body.append(r"\EndDirection")
        body.append(rf"\Direction{{{name}}}{{\Ru{{Русский – шведский}}}}{{{plural_terms(len(russian))}}}{{Русский – шведский}}")
        body.append(section(russian, russian_entry, f"{course['id']}-ru"))
        body.append(r"\EndDirection")
    body.append(r"\end{document}")
    return "\n".join(body), entries


# ------------------------------------------------------------ build and check


def compile_pdf(source: str, target: Path) -> tuple[int, list[str]]:
    with tempfile.TemporaryDirectory() as work:
        folder = Path(work)
        (folder / "book.tex").write_text(source, encoding="utf-8")
        (folder / "book.toc").write_text("", encoding="utf-8")
        # Twice: the first pass finds the page numbers the contents page shows,
        # the second lays out with them, the third settles the outline.
        for _ in range(3):
            result = subprocess.run(
                ["xelatex", "-interaction=batchmode", "-halt-on-error", "book.tex"],
                cwd=folder, capture_output=True, text=True, errors="replace",
            )
            log = (folder / "book.log").read_text(encoding="utf-8", errors="replace")
            if result.returncode != 0:
                tail = "\n".join(line for line in log.splitlines() if line.startswith("!"))[:900]
                raise SystemExit(f"xelatex failed for {target.name}:\n{tail or log[-1500:]}")
        missing = sorted(set(re.findall(r"Missing character: There is no (.+?) in font", log)))
        overfull = [float(n) for n in re.findall(r"Overfull \\hbox \(([\d.]+)pt too wide\)", log)]
        shutil.copy(folder / "book.pdf", target)
    pages = len(pymupdf.open(target))
    problems = [f"font has no glyph for {p}" for p in missing]
    wide = [n for n in overfull if n > 1.5]
    if wide:
        problems.append(f"{len(wide)} lines run past the column, worst by {max(wide):.1f}pt")
    return pages, problems


def squash(text: str) -> str:
    """Text with everything hyphenation or layout can change removed."""

    text = unicodedata.normalize("NFC", text).casefold()
    return re.sub(r"[\s\-­‐‑]+", "", text)


def check_pdf(path: Path, entries: dict[str, tuple[list, list]]) -> list[str]:
    """Read the finished book back and compare it with the data."""

    problems: list[str] = []
    doc = pymupdf.open(path)
    text_parts: list[str] = []
    for number, page in enumerate(doc, start=1):
        rect = page.rect
        # Between the running head and the page number, where entries live.
        body = pymupdf.Rect(0, 62, rect.width, rect.height - 48)
        text_parts.append(page.get_text("text", clip=body))
        for x0, y0, x1, y1, *_ in page.get_text("words"):
            if x0 < 40 or x1 > rect.width - 40 or y1 > rect.height - 20:
                problems.append(f"page {number}: text outside the margins at {x0:.0f},{y0:.0f}")
                break
    book = squash("".join(text_parts))

    expected = 0
    for swedish, russian in entries.values():
        for entry in swedish:
            for text in [entry.term, *entry.correct, *entry.tolerable]:
                expected += 1
                if squash(text) not in book:
                    problems.append(f"missing from the book: {text[:70]}")
        for entry in russian:
            expected += 1 + len(entry.swedish)
            for text in [entry.term, *entry.swedish]:
                if squash(text) not in book:
                    problems.append(f"missing from the book: {text[:70]}")
    fonts = {font[3] for page in doc for font in page.get_fonts()}
    if any("PTSerif" not in name.replace(" ", "") and "PT" not in name for name in fonts):
        problems.append(f"unexpected fonts: {sorted(fonts)}")
    print(f"    checked {expected} strings on {len(doc)} pages; fonts: {', '.join(sorted(fonts))}")
    return problems


def self_test() -> None:
    swedish = ["ananas", "Zebra", "ål", "ärr", "östrogen", "extraktion", "(Hem- och) sjukvård", "hälsa", "halsont"]
    ordered = sorted(swedish, key=sort_key)
    assert ordered == ["ananas", "extraktion", "halsont", "hälsa", "(Hem- och) sjukvård", "Zebra", "ål", "ärr", "östrogen"], ordered
    assert sort_letters("(Hem- och) sjukvård") == "sjukvård"
    russian = sorted(["яд", "ёж", "еда", "жаба", "йод", "иск", "(денежное) требование", "тест", "ухо", "Закон “О школе”"], key=sort_key)
    assert russian.index("еда") < russian.index("ёж") < russian.index("жаба"), russian
    assert russian.index("иск") < russian.index("йод"), russian
    assert russian.index("тест") < russian.index("(денежное) требование") < russian.index("ухо"), russian
    assert russian[-1] == "яд"
    assert initial("Закон “О школе”") == "З" and initial("ёж") == "Е" and initial("“Bra”") == "B" and initial("1177") == "0–9"
    assert sort_key("BNP") < sort_key("абсцесс"), "Latin files before Cyrillic"
    assert tex("50 % & A_b") == r"50 \% \& A\_b"
    assert flow("a-b - c") == r"a\nobreak\hskip0pt-\hskip0pt b - c"
    assert flow_ru("kontraheringsplikt, LMA") == r"\Sv{kontraheringsplikt}, LMA"
    assert split_head("двоемужие (Лицо состоит (bigami).)") == ("двоемужие", " (Лицо состоит (bigami).)")
    assert split_head("(денежное) требование") == ("(денежное) требование", "")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("only", nargs="?", help="build just this course, by id")
    args = parser.parse_args()
    self_test()

    data = json.loads(GLOSSARY.read_text(encoding="utf-8"))
    courses = data["dictionaries"]
    OUTPUT.mkdir(parents=True, exist_ok=True)

    plan: list[tuple[str, str, list[dict], str]] = []
    for course in courses:
        if not args.only or args.only == course["id"]:
            plan.append((course["id"], f"Tolkstöd ordbok – {course['name']}.pdf", [course], course["name"]))
    if not args.only:
        plan.insert(0, ("all", "Tolkstöd ordbok.pdf", courses, " · ".join(c["name"] for c in courses)))
    if not plan:
        raise SystemExit(f"no course {args.only!r}; have {[c['id'] for c in courses]}")

    manifest: list[dict] = []
    failed = False
    for book_id, name, selected, courses_line in plan:
        target = OUTPUT / f"{book_id}.pdf"
        print(f"  {name}")
        source, entries = document(selected, "Ordbok för tolkar", courses_line)
        pages, problems = compile_pdf(source, target)
        problems += check_pdf(target, entries)
        print(f"    {pages} pages, {target.stat().st_size / 1_000_000:.1f} MB, {len(problems)} problems")
        for problem in problems[:15]:
            print(f"    ! {problem}")
        failed = failed or bool(problems)
        manifest.append({"id": book_id, "pdf": target.name, "name": name, "pages": pages})

    if not args.only:
        (OUTPUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
