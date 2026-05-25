import argparse
import json
import os
import re
import time
from pathlib import Path

from faster_whisper import WhisperModel
import cutlet
from pykakasi import kakasi


ALLOWED_CHARS_PATTERN = re.compile(r"^[\u3040-\u309F\u30A0-\u30FFー\s、。！？,.!?\-]*$")


def katakana_to_hiragana(text: str) -> str:
    out = []
    for ch in text:
        code = ord(ch)
        if 0x30A1 <= code <= 0x30F6:
            out.append(chr(code - 0x60))
        else:
            out.append(ch)
    return "".join(out)


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def build_suppress_tokens(model: WhisperModel) -> list[int]:
    tok = model.hf_tokenizer
    vocab_size = tok.get_vocab_size()

    blocked = []
    for idx in range(vocab_size):
        piece = tok.decode([idx], skip_special_tokens=False)
        if not piece:
            continue
        if piece.startswith("<|") and piece.endswith("|>"):
            continue
        if not ALLOWED_CHARS_PATTERN.fullmatch(piece):
            blocked.append(idx)

    return blocked


def transcribe_whisper(model: WhisperModel, audio_path: str, *, suppress_tokens=None, hint_text="") -> str:
    kwargs = {
        "language": "ja",
        "beam_size": 5,
        "vad_filter": True,
        "condition_on_previous_text": False,
    }
    if suppress_tokens is not None:
        kwargs["suppress_tokens"] = suppress_tokens
    if hint_text:
        kwargs["initial_prompt"] = hint_text

    segments, _ = model.transcribe(audio_path, **kwargs)
    text = "".join(seg.text for seg in segments)
    return normalize_text(text)


def hira_with_pykakasi(text: str) -> str:
    conv = kakasi()
    parts = conv.convert(text)
    return normalize_text("".join(p["hira"] for p in parts))


def hira_with_cutlet(text: str) -> str:
    katsu = cutlet.Cutlet()
    pieces = []
    for token in katsu.tagger(text):
        reading = getattr(token.feature, "kana", "") or token.surface
        pieces.append(reading)
    return normalize_text(katakana_to_hiragana("".join(pieces)))


def levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)

    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        curr = [i]
        for j, cb in enumerate(b, start=1):
            ins = curr[j - 1] + 1
            delete = prev[j] + 1
            sub = prev[j - 1] + (0 if ca == cb else 1)
            curr.append(min(ins, delete, sub))
        prev = curr
    return prev[-1]


def run(args):
    started = time.time()

    model = WhisperModel(args.model_size, device="cpu", compute_type="int8")

    base_transcript = transcribe_whisper(model, args.audio)

    if args.mode == "2.1":
        suppress = build_suppress_tokens(model)
        transcript = transcribe_whisper(model, args.audio, suppress_tokens=suppress)
        hiragana = katakana_to_hiragana(transcript)
        note = f"suppress_tokens={len(suppress)}"

    elif args.mode == "2.2":
        hinted = transcribe_whisper(model, args.audio, hint_text=(args.hint_text or base_transcript))
        suppress = build_suppress_tokens(model)
        audio_kana = katakana_to_hiragana(
            transcribe_whisper(model, args.audio, suppress_tokens=suppress, hint_text=args.hint_text)
        )

        if args.converter == "pykakasi":
            hiragana = hira_with_pykakasi(hinted)
        else:
            hiragana = hira_with_cutlet(hinted)

        dist = levenshtein(audio_kana.replace(" ", ""), hiragana.replace(" ", ""))
        transcript = hinted
        note = f"audio-kanaと文脈読みの編集距離={dist}"

    else:  # 3.1
        transcript = base_transcript
        if args.converter == "pykakasi":
            hiragana = hira_with_pykakasi(transcript)
            note = "3.1 pykakasi 変換"
        else:
            hiragana = hira_with_cutlet(transcript)
            note = "3.1 cutlet(fugashi) 変換"

    elapsed = round(time.time() - started, 3)

    return {
        "mode": args.mode,
        "converter": args.converter,
        "model_size": args.model_size,
        "transcript": transcript,
        "hiragana": hiragana,
        "elapsed_sec": elapsed,
        "note": note,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--mode", choices=["2.1", "2.2", "3.1"], default="3.1")
    parser.add_argument("--converter", choices=["cutlet", "pykakasi"], default="cutlet")
    parser.add_argument("--hint-text", default="")
    parser.add_argument("--model-size", choices=["tiny", "base", "small"], default="base")
    args = parser.parse_args()

    if not os.path.exists(args.audio):
        raise FileNotFoundError(args.audio)

    result = run(args)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
