# 顔骨格 × 表情判定デモ

iPhone の Safari で動く、顔の骨格（ランドマーク）をリアルタイム検出し、表情を判定する Web アプリのデモです。すべてブラウザ内で完結し、映像はサーバーに送信されません。

## 使用技術

- **[MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)**（Google製・オープンソース）
  - 468点の顔メッシュ + 52種の表情係数（blendshapes）をブラウザ内で推論
- ビルド不要の静的サイト（HTML / CSS / JS）。CDN からモデルと WASM を読み込み

## 機能

- 顔の骨格を映像に重ね合わせ表示
  - 顔メッシュ（テッセレーション）／顔の輪郭／目・眉・唇・虹彩のライン／全468点のポイント
  - 各レイヤーは ON/OFF 切替可能
- 表情判定（笑顔・驚き・口あんぐり・口すぼめ・しかめ面・への字・目つむり・ベー）
- 主要な表情係数のバー表示、FPS 表示、左右反転切替

## ローカルで動かす

カメラは「安全なコンテキスト（HTTPS または localhost）」でのみ動作します。

```bash
# どちらか
npx serve .
# または
python3 -m http.server 8000
```

ブラウザで `http://localhost:8000`（または serve が表示する URL）を開きます。
PC の Safari / Chrome で動作確認できます。実機 iPhone は HTTPS が必要なので Vercel 等で公開してください。

## Vercel へデプロイ

ビルド設定は不要です（静的サイト）。

```bash
npm i -g vercel   # 未インストールの場合
vercel login
vercel --prod
```

- Framework Preset: **Other**
- Build Command: なし
- Output Directory: `.`（ルート）

デプロイ後、発行された HTTPS URL を iPhone の Safari で開いてください。
