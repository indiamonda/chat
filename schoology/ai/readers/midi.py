"""MIDI reader via mido. Reports tempo, tracks, key signature, and note counts.

The output is a textual summary -- MIDI is binary so we don't try to
return a hex dump.
"""

from collections import Counter
from pathlib import Path

# Mapping from MIDI note number to name (C4 = 60).
_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _note_name(n: int) -> str:
    return _NOTE_NAMES[n % 12] + str(n // 12 - 1)


def read(path: Path) -> str:
    import mido
    mid = mido.MidiFile(str(path))
    parts = []
    parts.append(f"MIDI file: {path.name}")
    parts.append(f"Type: {mid.type}  Tracks: {len(mid.tracks)}  Ticks per beat: {mid.ticks_per_beat}")
    # Tempo + key sig are meta messages at the head of the first track.
    for track in mid.tracks[:3]:
        for msg in track:
            if msg.type == "set_tempo":
                us = msg.tempo
                bpm = mido.tempo2bpm(us)
                parts.append(f"Tempo: {bpm:.1f} BPM")
                break
        for msg in track:
            if msg.type == "key_signature":
                parts.append(f"Key signature: {msg.key}")
                break
    # Note counts per track.
    for ti, track in enumerate(mid.tracks):
        notes = [m for m in track if m.type == "note_on" and getattr(m, "velocity", 0) > 0]
        if not notes:
            continue
        pitches = [m.note for m in notes]
        counter = Counter(_note_name(p) for p in pitches)
        top = counter.most_common(5)
        parts.append(
            f"Track {ti} ({track.name or '(unnamed)'}): {len(notes)} notes, "
            f"range {_note_name(min(pitches))}-{_note_name(max(pitches))}, "
            f"most common: {', '.join(f'{n}({c})' for n, c in top)}"
        )
    return "\n".join(parts)
