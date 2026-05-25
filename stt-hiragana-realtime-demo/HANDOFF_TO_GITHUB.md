# GitHub 公開用ハンドオフ手順

このフォルダは、元の private リポジトリから切り出した **公開用の最小構成** です。

## 1) 新しいGitHubアカウント側で公開リポジトリを作成

例: `stt-hiragana-realtime-demo`

## 2) このフォルダで初期化して push

```powershell
git init
git add .
git commit -m "Initial public release"
git branch -M main
git remote add origin https://github.com/<YOUR_ACCOUNT>/stt-hiragana-realtime-demo.git
git push -u origin main
```

## 3) 起動確認

```powershell
npm install
python -m pip install -r requirements.txt
node server.js
```

ブラウザ: `http://localhost:3100`

## セキュリティ補足

- 元リポジトリの private 資産はこのフォルダに含めていません。
- `node_modules` や `tmp` は `.gitignore` 済みです。
- Python 実行パスは以下優先で解決します:
  1. `PYTHON_BIN` 環境変数
  2. 親ディレクトリの `.venv-openwebui311\Scripts\python.exe`（存在時）
  3. `python` コマンド
