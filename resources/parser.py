"""Parser script executed by the Electron main process.

Reads the text to parse from stdin and writes a single JSON object to
stdout. Keep stdout JSON-only; anything intended for debugging belongs on
stderr.
"""

import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone

READING_WPM = 200
TOP_WORDS_LIMIT = 8

# Common English words that carry no signal in a frequency chart.
STOPWORDS = frozenset("""
a an and are as at be but by for from had has have he her hers him his i in is
it its of on or she that the their them they this to was were will with you
your
""".split())


def words_of(text: str) -> list[str]:
    return re.findall(r"\w+", text.lower())


def top_words(words: list[str]) -> list[dict]:
    counted = Counter(w for w in words if len(w) > 1 and w not in STOPWORDS)
    return [
        {"word": word, "count": count}
        for word, count in counted.most_common(TOP_WORDS_LIMIT)
    ]


def length_buckets(words: list[str]) -> list[dict]:
    buckets = {"1-3": 0, "4-6": 0, "7-9": 0, "10+": 0}
    for word in words:
        length = len(word)
        if length <= 3:
            buckets["1-3"] += 1
        elif length <= 6:
            buckets["4-6"] += 1
        elif length <= 9:
            buckets["7-9"] += 1
        else:
            buckets["10+"] += 1
    return [{"label": label, "count": count} for label, count in buckets.items()]


def parse(text: str) -> dict:
    """Replace this with real parsing logic."""
    words = words_of(text)
    sentences = [s for s in re.split(r"[.!?]+", text) if s.strip()]
    paragraphs = [p for p in re.split(r"\n\s*\n", text) if p.strip()]
    word_count = len(words)

    return {
        "lineCount": len(text.splitlines()),
        "paragraphCount": len(paragraphs),
        "sentenceCount": len(sentences),
        "wordCount": word_count,
        "uniqueWordCount": len(set(words)),
        "charCount": len(text),
        "charCountNoSpaces": len(text) - text.count(" ") - text.count("\n"),
        "avgWordLength": round(sum(len(w) for w in words) / word_count, 2)
        if words
        else 0,
        "avgWordsPerSentence": round(word_count / len(sentences), 2)
        if sentences
        else 0,
        "readingTimeSeconds": round(word_count / READING_WPM * 60),
        "longestWord": max(words, key=len) if words else "",
        "topWords": top_words(words),
        "wordLengthBuckets": length_buckets(words),
        "parsedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def main() -> int:
    try:
        data = parse(sys.stdin.read())
    except Exception as exc:  # report any parse failure as JSON, not a traceback
        json.dump({"error": str(exc)}, sys.stdout)
        return 1

    json.dump(data, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
