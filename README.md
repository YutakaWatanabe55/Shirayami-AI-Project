# Shirayami-AI-Project

## Public Demo

- `stt-hiragana-realtime-demo`: リアルタイム STT + ひらがな3方式比較デモ
  - README: `stt-hiragana-realtime-demo/README.md`
  - 方式概要: `stt-hiragana-realtime-demo/THREE_METHODS_OVERVIEW.md`

## 次エージェントへの引継ぎ

- 現在の公開対象は `stt-hiragana-realtime-demo` ディレクトリです。
- リアルタイム処理は「累積チャンク送信」で実装済みです（途中で文字起こしが止まりにくい構成）。
- サーバー起動コマンド（Windows想定）:
  - `node stt-hiragana-realtime-demo/server.js`
- 必要依存:
  - Node: `npm install`（`stt-hiragana-realtime-demo` 配下）
  - Python: `python -m pip install -r stt-hiragana-realtime-demo/requirements.txt`
- 実装の主要ファイル:
  - `stt-hiragana-realtime-demo/server.js`
  - `stt-hiragana-realtime-demo/scripts/run_realtime_worker.py`
  - `stt-hiragana-realtime-demo/public/app.js`
- 比較方式:
  - `2.1` Whisper suppress_tokens
  - `2.2` ヒント付き再推論 + cutlet
  - `3.1` 後処理 cutlet
- 直近で `main` に同期済みです。次の作業はこの `main` を基準に進めてください。
