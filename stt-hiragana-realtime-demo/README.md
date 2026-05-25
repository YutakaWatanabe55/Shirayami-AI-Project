# STT + ひらがな変換リアルタイムデモ（Node.jsローカル）

このデモは、**リアルタイム文字起こし**を先に実施し、続いて以下の3手法を**同時実行**して表示します。

- `2.1` Whisper `suppress_tokens`（かな寄せ）
- `2.2` ヒント付き再推論 + cutlet
- `3.1` 後処理ひらがな化（cutlet）

画面では、文字起こし結果と各手法のひらがな結果、さらに各モードの `avg/latest` 処理時間を確認できます。

## 前提

- Windows + PowerShell
- Python: `../.venv-openwebui311/Scripts/python.exe`
- Node.js: `.tools/node-v22.15.1-win-x64`

## セットアップ

```powershell
# Node modules
$env:Path = "$PWD\.tools\node-v22.15.1-win-x64;$env:Path"
& "$PWD\.tools\node-v22.15.1-win-x64\npm.cmd" install --prefix .\stt-hiragana-demo

# Python modules
.\.venv-openwebui311\Scripts\python.exe -m pip install -r .\stt-hiragana-demo\requirements.txt
```

## 起動

```powershell
$env:Path = "$PWD\.tools\node-v22.15.1-win-x64;$env:Path"
# モデルサイズ変更時は tiny/base/small を指定
$env:WHISPER_MODEL_SIZE = "base"
& "$PWD\.tools\node-v22.15.1-win-x64\node.exe" .\stt-hiragana-demo\server.js
```

- ブラウザで `http://localhost:3100`

## API

- `POST /api/session/start`
- `POST /api/session/:id/chunk` (`multipart/form-data`: `audio`, `seq`, `hintText`)
- `GET /api/session/:id/status`
- `POST /api/session/:id/end`

## 実装メモ

- Python常駐ワーカー `scripts/run_realtime_worker.py` でWhisperモデルを保持し、チャンクごとに処理。
- 各チャンクで:
  1. まずリアルタイムSTT
  2. その後 `2.1 / 2.2 / 3.1` を同時実行
- `2.2` は研究実装の完全再現ではなく、PoCとしてヒント付き再推論 + 読み比較を実装。
