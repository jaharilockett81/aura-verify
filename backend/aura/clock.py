"""Time helpers for reminders and timers. Due times are wall-clock times in the household's time zone."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, tzinfo
from zoneinfo import ZoneInfo


def household_tz(name: str = "") -> tzinfo:
    if name:
        return ZoneInfo(name)
    return datetime.now().astimezone().tzinfo or UTC


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def utcnow() -> datetime:
    return datetime.now(UTC)


def next_occurrence(hhmm: str, tz: tzinfo, now: datetime | None = None) -> datetime:
    """The next time the wall clock in `tz` reads HH:MM (today if still ahead, otherwise tomorrow)."""
    now = (now or utcnow()).astimezone(tz)
    hour, minute = (int(x) for x in hhmm.split(":"))
    at = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if at <= now:
        at += timedelta(days=1)
    return at


def local_hhmm(dt: datetime, tz: tzinfo) -> str:
    return dt.astimezone(tz).strftime("%H:%M")
