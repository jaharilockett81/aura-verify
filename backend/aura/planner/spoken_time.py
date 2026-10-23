"""Find a clock time in a typed or spoken request, as speech recognisers actually write it.

Chrome's speech recognition writes "seven forty a.m." in several ways: "7:40 a.m.", "7 40 a.m.", "740 a.m.",
"7:40 AM" or, now and then, "seven forty a.m.". This module turns all of them into an hour, a minute and (when the
user said it) AM/PM, and reports the exact span of the time phrase so it can be removed from the reminder's title.

It never invents what wasn't said: no AM/PM means `meridiem is None` (unless the hour can only be 24-hour, or a
day part such as "tonight" settles it), and a reading that needed guessing is marked `guessed` so the planner asks
"Did you mean 7:40 AM?" before anything is saved.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

HOUR_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
              "ten": 10, "eleven": 11, "twelve": 12}
UNITS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9}
TEENS = {"ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
         "seventeen": 17, "eighteen": 18, "nineteen": 19}
TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fourty": 40, "fifty": 50}
PREFIXES = {"at", "for", "by", "around", "about"}
PM_PARTS = ("in the afternoon", "in the evening", "at night", "tonight", "this evening", "this afternoon")
AM_PARTS = ("in the morning", "this morning")

# "a.m." / "a. m." / "A.M" → "am", but only right after a number or number word, so "I am" is left alone.
_MERIDIEM = re.compile(r"(?<=[\w:.])\s*\b([ap])\s?\.\s?m\b\.?|(?<=\d)\s*([ap])\s+m\b\.?|(?<=\d)([ap]m)\b\.?",
                       re.IGNORECASE)
_TOKEN = re.compile(r"\d{1,2}:\d{2}|\d+|o'clock|[a-z]+(?:'[a-z]+)?|[:.]")


@dataclass
class SpokenTime:
    hour: int  # as said: 7 for "seven forty", 19 for "19:40"
    minute: int
    meridiem: str | None  # "am" / "pm" when said (or settled by "tonight", "in the morning"); None otherwise
    twenty_four_hour: bool  # "19:40", "07:40": no AM/PM needed
    day: str | None  # "today" / "tomorrow" when said
    start: int  # span of the whole time phrase (including "at", "a.m.", "tonight") in the normalised text
    end: int
    guessed: bool  # e.g. "740 a.m." read as 7:40: confirm before saving
    text: str  # the normalised text the span refers to

    @property
    def needs_meridiem(self) -> bool:
        return self.meridiem is None and not self.twenty_four_hour and 1 <= self.hour <= 12

    def hhmm(self, meridiem: str | None = None) -> str | None:
        """24-hour HH:MM, or None while AM/PM is still unknown."""
        m = meridiem or self.meridiem
        h = self.hour
        if self.twenty_four_hour or (m is None and not 1 <= h <= 12):
            return f"{h:02d}:{self.minute:02d}"
        if m is None:
            return None
        if m == "pm" and h < 12:
            h += 12
        if m == "am" and h == 12:
            h = 0
        return f"{h:02d}:{self.minute:02d}"

    def say(self, meridiem: str | None = None) -> str:
        """How AURA reads it back: "7:40 AM", or "7:40" while AM/PM is unknown."""
        hhmm = self.hhmm(meridiem)
        if hhmm is None:
            return f"{self.hour}:{self.minute:02d}"
        return say_hhmm(hhmm)


def say_hhmm(hhmm: str) -> str:
    hour, minute = map(int, hhmm.split(":"))
    return f"{hour % 12 or 12}:{minute:02d} {'AM' if hour < 12 else 'PM'}"


def normalise(text: str) -> str:
    """Lower-case, unify "a.m."-style suffixes and "o'clock" spellings; keeps everything else in place."""
    t = text.lower().replace("’", "'")
    t = re.sub(r"\bo\s?'?\s?clock\b", "o'clock", t)
    t = _MERIDIEM.sub(lambda m: " " + (m.group(1) or m.group(2) or m.group(3)[0]).lower() + "m", t)
    return re.sub(r"[ \t]+", " ", t)


class _Tokens:
    def __init__(self, text: str):
        self.items = [(m.group(0), m.start(), m.end()) for m in _TOKEN.finditer(text)]

    def word(self, i: int) -> str | None:
        return self.items[i][0] if 0 <= i < len(self.items) else None


def _hour_at(tok: _Tokens, i: int) -> tuple[int, int, bool] | None:
    """(hour, tokens used, was a word) for an hour at token i: "7", "07", "seven"."""
    w = tok.word(i)
    if w is None:
        return None
    if w.isdigit() and len(w) <= 2 and int(w) <= 23:
        return int(w), 1, False
    if w in HOUR_WORDS:
        return HOUR_WORDS[w], 1, True
    return None


def _minute_at(tok: _Tokens, i: int) -> tuple[int, int] | None:
    """(minute, tokens used) for "40", "05", "forty", "forty five", "oh five", "fifteen"."""
    w = tok.word(i)
    if w is None:
        return None
    if w.isdigit() and len(w) == 2 and int(w) <= 59:
        return int(w), 1
    if w in ("oh", "o") and tok.word(i + 1) in UNITS:
        return UNITS[tok.word(i + 1)], 2
    if w in TENS:
        nxt = tok.word(i + 1)
        if nxt in UNITS:
            return TENS[w] + UNITS[nxt], 2
        return TENS[w], 1
    if w in TEENS:
        return TEENS[w], 1
    return None


def _meridiem_at(tok: _Tokens, i: int) -> tuple[str, int] | None:
    w = tok.word(i)
    if w in ("am", "pm"):
        return w, 1
    return None


def _count_word(w: str | None) -> int | None:
    if w is None:
        return None
    if w.isdigit() and int(w) <= 59:
        return int(w)
    return {**UNITS, **TEENS, **TENS}.get(w)


def find_time(text: str) -> SpokenTime | None:
    """The first clock time in `text` (already lower-cased is fine), or None."""
    t = normalise(text)
    tok = _Tokens(t)
    n = len(tok.items)
    for i in range(n):
        found = _time_at(tok, i)
        if found is None:
            continue
        hour, minute, meridiem, h24, used, guessed = found
        first, last = i, i + used - 1
        if tok.word(first - 1) in PREFIXES:
            first -= 1
        start, end = tok.items[first][1], tok.items[last][2]
        # A day part right after the time settles AM/PM and belongs to the phrase.
        rest = t[end:]
        for part, mer in [(p, "pm") for p in PM_PARTS] + [(p, "am") for p in AM_PARTS]:
            m = re.match(r"[\s,]*" + part + r"\b", rest)
            if m:
                end += m.end()
                if meridiem is None and not h24:
                    meridiem = mer
                break
        if meridiem is None and not h24 and re.search(r"\btonight\b", t):
            meridiem = "pm"
        if meridiem is None and not h24 and re.search(r"\b(?:this|tomorrow) morning\b", t):
            meridiem = "am"
        if meridiem is None and not h24 and re.search(r"\b(?:this|tomorrow) (?:afternoon|evening)\b", t):
            meridiem = "pm"
        day = "tomorrow" if re.search(r"\btomorrow\b", t) else ("today" if re.search(r"\b(today|tonight|this "
                                                                                       r"(morning|afternoon|evening))\b", t) else None)
        if meridiem is not None and hour > 12:
            return SpokenTime(hour, minute, meridiem, False, day, start, end, True, t)  # "19 pm": caller asks
        return SpokenTime(hour, minute, meridiem, h24, day, start, end, guessed, t)
    return None


def _time_at(tok: _Tokens, i: int):
    """Try every supported shape at token i. Returns (hour, minute, meridiem, 24h, tokens used, guessed)."""
    w = tok.word(i)
    prefixed = tok.word(i - 1) in PREFIXES

    # noon / midnight
    if w in ("noon", "midday"):
        return 12, 0, "pm", False, 1, False
    if w == "midnight":
        return 0, 0, None, True, 1, False

    # "half past five", "quarter past seven", "quarter to eight", "ten past seven", "twenty to nine"
    if w in ("half", "quarter") or (_count_word(w) is not None and tok.word(i + 1) in ("past", "to", "after")):
        j = i + 1
        if w == "quarter" and tok.word(j) == "of":
            tok_rel = "to"
        else:
            tok_rel = tok.word(j)
        if w in ("half", "quarter"):
            minutes = 30 if w == "half" else 15
        else:
            minutes = _count_word(w)
            if tok.word(j) in ("minute", "minutes"):
                j += 1
                tok_rel = tok.word(j)
        if tok_rel in ("past", "after", "to", "of") and minutes is not None and 0 < minutes < 60:
            h = _hour_at(tok, j + 1)
            if h and 1 <= h[0] <= 12:
                hour, used = h[0], j + 1 + h[1] - i
                minute = minutes
                if tok_rel in ("to", "of"):
                    hour, minute = (hour - 1) or 12, 60 - minutes
                mer = _meridiem_at(tok, i + used)
                return hour, minute, mer[0] if mer else None, False, used + (1 if mer else 0), False

    # "7:40", "19:40", "07:40" (one token)
    if w and re.fullmatch(r"\d{1,2}:\d{2}", w):
        hour, minute = (int(x) for x in w.split(":"))
        if hour > 23 or minute > 59:
            return None
        mer = _meridiem_at(tok, i + 1)
        h24 = mer is None and (hour == 0 or hour > 12 or w.startswith("0"))
        return hour, minute, mer[0] if mer else None, h24, 1 + (1 if mer else 0), False

    # "740 a.m." / "1930": run-together digits. Only with AM/PM or a leading "at"; always confirmed.
    if w and w.isdigit() and len(w) in (3, 4):
        hour, minute = int(w[:-2]), int(w[-2:])
        mer = _meridiem_at(tok, i + 1)
        if minute <= 59 and hour <= 23 and (mer or prefixed):
            if mer and hour > 12:
                return None
            h24 = mer is None and (hour == 0 or hour > 12)
            return hour, minute, mer[0] if mer else None, h24, 1 + (1 if mer else 0), True

    h = _hour_at(tok, i)
    if h is None:
        return None
    hour, used, _word = h
    j = i + used
    # "7: a.m." (a transcript that lost its minutes): read as 7:00 AM, but only after asking.
    if tok.word(j) in (":", ".") and _meridiem_at(tok, j + 1) and 1 <= hour <= 12:
        return hour, 0, _meridiem_at(tok, j + 1)[0], False, used + 2, True
    # "7 o'clock"
    if tok.word(j) == "o'clock":
        mer = _meridiem_at(tok, j + 1)
        return hour, 0, mer[0] if mer else None, False, used + 1 + (1 if mer else 0), False
    # "7 40 a.m.", "seven forty five pm", "seven oh five" (hour then minutes as separate words)
    mins = _minute_at(tok, j)
    if mins is not None and hour <= 23:
        k = j + mins[1]
        mer = _meridiem_at(tok, k)
        if tok.word(k) == "o'clock":
            mins = None
        elif mer or prefixed or _day_part_follows(tok, k):
            if mer and hour > 12:
                return None
            return hour, mins[0], mer[0] if mer else None, mer is None and hour > 12, k - i + (1 if mer else 0), False
    # "7 am", "seven pm", "at 7", "at seven", "7 tonight"
    mer = _meridiem_at(tok, j)
    if mer:
        if hour > 12 or hour == 0:
            return None
        return hour, 0, mer[0], False, used + 1, False
    if prefixed and (not _word or hour >= 1) and hour <= 23 and tok.word(j) not in ("minutes", "minute", "hours",
                                                                                     "hour", "days", "day"):
        return hour, 0, None, hour > 12 or hour == 0, used, False
    if _day_part_follows(tok, j) and 1 <= hour <= 12:
        return hour, 0, None, False, used, False
    return None


def _day_part_follows(tok: _Tokens, k: int) -> bool:
    w, nxt = tok.word(k), tok.word(k + 1)
    return w == "tonight" or (w == "in" and nxt == "the") or (w == "at" and nxt == "night") or (
        w == "this" and nxt in ("morning", "afternoon", "evening"))


def mentions_a_time(text: str) -> bool:
    """True when the text clearly tries to say a time we couldn't read (so we ask instead of ignoring it)."""
    t = normalise(text)
    return bool(re.search(r"\d\s*(am|pm)\b|\b(am|pm|o'clock)\b|\b(at|by)\s+\d", t))
