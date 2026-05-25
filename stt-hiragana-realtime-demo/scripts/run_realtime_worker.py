import argparse
import concurrent.futures
import json
import os
import re
import sys
import time

from faster_whisper import WhisperModel
import cutlet


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
        "beam_size": 1,
        "best_of": 1,
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


def process_one(req: dict, model_rt, model_21, model_22, suppress_tokens: list[int]) -> dict:
    audio = req["audio"]
    hint_text = req.get("hint_text", "")

    if not os.path.exists(audio):
        raise FileNotFoundError(audio)

    t0 = time.perf_counter()

    rt_start = time.perf_counter()
    rt_text = transcribe_whisper(model_rt, audio)
    rt_elapsed_ms = (time.perf_counter() - rt_start) * 1000

    mode_start = time.perf_counter()

    def mode_21_job():
        s = time.perf_counter()
        text_21 = transcribe_whisper(model_21, audio, suppress_tokens=suppress_tokens)
        hira_21 = katakana_to_hiragana(text_21)
        return {
            "transcript": text_21,
            "hiragana": hira_21,
            "elapsed_ms": round((time.perf_counter() - s) * 1000, 1),
            "note": "Whisper suppress_tokens",
        }

    def mode_22_job():
        s = time.perf_counter()
        hinted = transcribe_whisper(model_22, audio, hint_text=(hint_text or rt_text))
        hira_22 = hira_with_cutlet(hinted)
        return {
            "transcript": hinted,
            "hiragana": hira_22,
            "elapsed_ms": round((time.perf_counter() - s) * 1000, 1),
            "note": "ヒント付き再推論 + cutlet",
        }

    def mode_31_job():
        s = time.perf_counter()
        hira_31 = hira_with_cutlet(rt_text)
        return {
            "transcript": rt_text,
            "hiragana": hira_31,
            "elapsed_ms": round((time.perf_counter() - s) * 1000, 1),
            "note": "後処理 cutlet",
        }

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as exe:
        f21 = exe.submit(mode_21_job)
        f22 = exe.submit(mode_22_job)
        f31 = exe.submit(mode_31_job)
        r21 = f21.result()
        r22 = f22.result()
        r31 = f31.result()

    r22["distance_to_21"] = levenshtein(
        r21["hiragana"].replace(" ", ""),
        r22["hiragana"].replace(" ", ""),
    )

    return {
        "realtime": {
            "transcript": rt_text,
            "elapsed_ms": round(rt_elapsed_ms, 1),
        },
        "modes": {
            "2.1": r21,
            "2.2": r22,
            "3.1": r31,
        },
        "mode_group_elapsed_ms": round((time.perf_counter() - mode_start) * 1000, 1),
        "total_elapsed_ms": round((time.perf_counter() - t0) * 1000, 1),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-size", choices=["tiny", "base", "small"], default="base")
    args = parser.parse_args()

    sys.stdout.reconfigure(line_buffering=True)

    model_rt = WhisperModel(args.model_size, device="cpu", compute_type="int8")
    model_21 = WhisperModel(args.model_size, device="cpu", compute_type="int8")
    model_22 = WhisperModel(args.model_size, device="cpu", compute_type="int8")
    suppress_tokens = build_suppress_tokens(model_21)

    print(json.dumps({"type": "ready", "model_size": args.model_size, "suppress_tokens": len(suppress_tokens)}, ensure_ascii=False))

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        req = None
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            result = process_one(req, model_rt, model_21, model_22, suppress_tokens)
            print(json.dumps({"id": req_id, "ok": True, "result": result}, ensure_ascii=False))
        except Exception as exc:
            print(json.dumps({"id": req_id, "ok": False, "error": str(exc)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
