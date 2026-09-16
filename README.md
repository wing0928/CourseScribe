# CourseScribe（課間捕手）

CourseScribe 是 Windows 桌面版線上課程錄製與課後整理工具。它使用本機 Whisper 模型，在課後將錄製內容轉成逐字稿，再整理成課程重點與筆記。

## 目前版本

`0.1.7`

- 一鍵錄製主要桌面畫面、Windows 系統音訊與麥克風
- 上傳 MP4、WebM、MOV、MKV、MP3、WAV、M4A、AAC、OGG、FLAC 等錄音或影音檔
- 修正可攜版 ffmpeg 路徑，新增影音檔可正常抽取音訊並轉錄
- 課後以本機 Whisper `whisper-small`（CPU / q4）轉錄，不需要付費 API
- 產生逐字稿、關鍵字與課程筆記
- 錄影檔使用時間戳命名，避免覆蓋上一堂課
- 轉錄與錄製狀態會寫入本機診斷記錄

## 使用方式

1. 下載 GitHub Releases 的 `CourseCapture-*-portable.exe`。
2. 開啟程式；可按「開始錄製」，或按「上傳錄音／影音」選擇既有檔案。
3. 選擇來源後按「使用 Whisper 轉錄」，等待本機模型完成。
4. 按「整理課程重點」。影音檔只會抽取音訊轉錄。

錄影、模型與診斷記錄預設留在本機，不會自動上傳課程內容。

## 從原始碼執行

```powershell
cd desktop-app
npm install
npm start
```

檢查與驗證指令：

```powershell
npm run check
npm run verify:ui
npm run verify:captions
```

## 版本記錄

完整的舊版程式碼與修正紀錄保留在 Git commit history；摘要請見 [CHANGELOG.md](CHANGELOG.md)。
