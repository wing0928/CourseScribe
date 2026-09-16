# CourseScribe（課間捕手）

CourseScribe 是 Windows 桌面版線上課程錄製與課後整理工具。它使用本機 Whisper 模型，在課後將錄製內容轉成逐字稿，再整理成課程重點與筆記。

## 目前版本

`0.1.9`

- Windows 桌面應用程式，單一執行個體；錄課時可縮成置頂小工具，不必切換分頁
- 首頁只負責匯入／錄影與進度；資料庫頁保存歷史課程、完整逐字稿與課程筆記
- 一鍵選取螢幕或課程視窗，同一份擷取串流同時保存影片與系統音訊
- 支援 MP4、WebM、MOV、MKV、MP3、WAV、M4A、AAC、OGG、FLAC 等錄音或影音檔
- 課後以本機 Whisper `whisper-small`（CPU / q4）轉錄，不需要付費 API
- 繁體中文使用離線 OpenCC `s2twp` 統一轉成臺灣繁體，不混入簡體字
- 本機 SQLite 媒體庫保存課程、時間戳逐字稿、處理進度、分類、學期與回收桶
- 可選擇本機 Ollama 的 Qwen 3 `qwen3:4b` 或 `qwen3:8b` 整理摘要、重點、名詞／公式、易混淆處與複習問題
- 影片課程可由逐字稿時間戳跳轉播放器；錄音課程保留時間戳但不顯示播放器

## 使用方式

1. 下載並開啟 `CourseScribe-0.1.9-portable.exe`。
2. 首頁選擇語言、分類、學期與筆記模型，再選取螢幕／課程視窗。
3. 按「開始錄製」；若已有檔案，也可按「匯入錄音／影片」。
4. 課後停止錄製；Whisper 會在本機完成逐字稿，完整內容到「資料庫」查看。
5. 若要整理筆記，安裝並啟動 Ollama，再在首頁下載 `qwen3:4b` 或 `qwen3:8b`。

錄影時可按「縮小成置頂小工具」，小工具提供暫停、繼續、停止與返回主程式。課程、媒體、模型與診斷記錄預設留在本機，不會自動上傳課程內容。

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
npm run verify:core
npm run verify:media
npm run verify:ollama
```

## 版本記錄

完整的舊版程式碼與修正紀錄保留在 Git commit history；摘要請見 [CHANGELOG.md](CHANGELOG.md)。
