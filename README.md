# CourseScribe（課間捕手）

CourseScribe 是 Windows 桌面版線上課程錄製與課後整理工具。它使用本機 Whisper 模型，在課後將錄製內容轉成逐字稿，再整理成課程重點與筆記。

## 目前版本

`0.1.14`

- Windows 桌面應用程式，單一執行個體；錄課時可縮成置頂小工具，不必切換分頁
- 首頁只負責匯入／錄影與進度；資料庫頁保存歷史課程、完整逐字稿與課程筆記
- 資料庫可在歷史課程詳情修改分類，或直接新增分類並套用
- 一鍵選取螢幕或課程視窗，同一份擷取串流同時保存影片與系統音訊
- 支援 MP4、WebM、MOV、MKV、MP3、WAV、M4A、AAC、OGG、FLAC 等錄音或影音檔
- 課後以本機 Whisper `whisper-small`（CPU / q4）轉錄，不需要付費 API
- 繁體中文使用離線 OpenCC `s2twp` 統一轉成臺灣繁體，不混入簡體字
- 本機 SQLite 媒體庫保存課程、時間戳逐字稿、處理進度、分類、學期與回收桶
- 可選擇本機 Ollama 的 Qwen 3 `qwen3:4b`、`qwen3:8b` 或 Gemma `gemma4:e2b`，依 [通用逐字稿整理規範](desktop-app/prompts/course-transcript-notes.md) 產生主題式章節、整體摘要、時間戳與複習問題；不使用固定科目模板。較大模型較慢，也不能保證修正逐字稿錯字
- 首頁筆記區可切換「主題總結／逐字稿」；總結的原文依據可按需展開，課外延伸會標示「補充／可能考」
- 課程中可確認的公式以 LaTeX 保存，使用本機 KaTeX 排版；摘要會檢查是否漏掉已核對的主題
- 每個重點附逐字稿原文短引文與程式核對出的時間戳；找不到一致原文時標「待核」。原文吻合不是外部事實查核，舊版筆記也須重新整理才有引文
- 筆記整理時顯示目前段落、生成字數、進度百分比和估計剩餘時間；第一段完成前會顯示「估算中」
- 影片課程可由逐字稿時間戳跳轉播放器；錄音課程保留時間戳但不顯示播放器

## 使用方式

1. 開啟 `desktop-app/release/CourseScribe-0.1.14-portable.exe`，或使用已安裝的同版本程式。
2. 首頁選擇語言、分類、學期與筆記模型，再選取螢幕／課程視窗。
3. 按「開始錄製」；若已有檔案，也可按「匯入錄音／影片」。
4. 課後停止錄製；Whisper 會在本機完成逐字稿，完整內容到「資料庫」查看。
5. 若要整理筆記，安裝並啟動 Ollama，再在首頁選擇或下載支援的模型（如 `qwen3:4b`、`qwen3:8b` 或 `gemma4:e2b`）。

錄影時可按「縮小成置頂小工具」，小工具提供暫停、繼續、停止與返回主程式。課程、媒體、模型與診斷記錄預設留在本機，不會自動上傳課程內容。

AI 筆記只根據 Whisper 逐字稿整理，並非外部事實查核。姓名、數字及難辨識的語句請利用筆記時間戳回到原影片核對。

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
