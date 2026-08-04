# local-code-agent

`local-code-agent` 是一個本地端 npm CLI，功能方向接近 Claude Code，但模型來源改成你自己電腦上的：

- `Ollama`
- `LM Studio`

它會在啟動時先做偵測：

- 讓使用者選擇 `Ollama` 或 `LM Studio`
- 使用上下鍵與 Enter 在終端內選擇
- 檢查電腦上是否有安裝該軟體
- 檢查本地 API 是否已啟動
- 檢查是否已有可用的本地模型
- 將使用者選過的 `provider` / `model` 自動寫回 `.local-code.json`

如果缺少任何一項，CLI 會直接提示使用者先安裝或先下載模型。

## 目前支援的能力

- 列出檔案
- 讀取檔案
- 讀取專案以外的檔案：在 `chat` 模式用 `/attach <路徑>` 附加電腦上任何位置的檔案（跟 Claude Code 一樣，會把解析出來的絕對路徑印在終端機上讓你確認讀到的是哪個檔案），下一則訊息送出時會一併帶給模型分析；模型也可以直接呼叫 `read_external_file` 工具讀取你在對話中提到的絕對路徑（唯讀、單檔上限 2MB，見下方「讀取專案以外的檔案」）
- 搜尋文字
- 建立資料夾
- 寫入或覆蓋檔案
- 追加內容到既有檔案（`append_file`），不用重新輸出整份既有內容
- 進行局部字串替換
- 寫入 `.py` / `.js` / `.mjs` 後自動做語法檢查，結果會回饋給模型自我修正
- 執行本地命令（`dotnet build`、`npm test`、`python xxx.py` 等）來編譯/測試/執行程式碼——預設每次執行前會在終端機跳出來問你要不要允許，`--allow-commands` 則整個 session 都自動允許不再詢問
- 上網查資料：`web_search`（DuckDuckGo 搜尋，回傳標題/連結/摘要）、`web_fetch`（抓單一網頁並轉成純文字給模型讀）——讓模型能回答訓練資料截止日之後的新資訊。預設每次連網前也會在終端機問你要不要允許，`--allow-network` 則整個 session 都自動允許不再詢問
- 用 `/名稱` 打關鍵字叫出自訂 Skill（見下方「Skill 系統」）
- 任務進度 Checkpoint：存目標/待辦事項，並自動附上最近對話內容，跨 session 恢復（見下方「任務進度 Checkpoint」）
- 背景子任務（`spawn_agent` / `check_agent` / `list_agents`）：模型遇到「多個彼此獨立」的子任務時，可以把其中一個丟到背景執行，自己繼續做別的事，之後再回來取結果（見下方「背景子任務」）

## 安裝（推薦，跟 Claude Code 一樣）

從 npm 全域安裝，裝完就能在任何資料夾直接打 `local-code`，不用額外初始化。以下指令在 Windows（PowerShell / cmd）、macOS、Linux 都通用：

```sh
npm install -g @jc20231028/local-code-agent
```

裝完之後，切到任何專案資料夾都可以直接執行：

```sh
cd /path/to/your-project      # Windows 上對應 cd C:\path\to\your-project
local-code chat
```

**注意：一定要加 `-g`。** 如果只下 `npm install @jc20231028/local-code-agent`（沒有 `-g`），
npm 只會把執行檔裝進當下專案的 `node_modules/.bin`，不會加進系統 PATH，
直接打 `local-code` 會抓不到指令。這種情況下要嘛加 `-g` 重裝，要嘛用 `npx local-code chat` 執行。

如果你已經用沒加 `-g` 的方式裝過，先移除本地安裝再改用全域安裝：

```sh
npm uninstall @jc20231028/local-code-agent
npm install -g @jc20231028/local-code-agent
```

> Windows 上如果 `npm` 指令解析有問題（例如某些 shell 找不到 `npm`），可以改用 `npm.cmd` 代替 `npm`。macOS / Linux 一律用 `npm` 即可，不需要（也沒有）`npm.cmd`。

`provider` / `model` 留空時，`local-code chat` 第一次啟動就會直接跳出互動選單讓你選（見下方「初始化設定」），
不需要先手動跑 `local-code init`——`init` 只是用來印出設定檔範例，不是必要步驟。

`workspace` 預設就是執行當下的 `process.cwd()`，所以不同專案資料夾會各自使用自己的 `.local-code.json` / `.local-code-state.json`（沒有的話 CLI 會在互動模式下詢問並建立）。

## 本地開發（clone 這個 repo 時使用）

```sh
npm install
```

直接執行：

```sh
node ./bin/local-code.js help
```

想在其他專案資料夾測試本地修改，可以用 `npm link` 掛成全域命令：

```sh
npm link
```

（Windows 上若 `npm` 解析有問題可改用 `npm.cmd`，macOS / Linux 不需要這個副檔名。）

## 初始化設定（選用）

```powershell
node ./bin/local-code.js init
```

建立 `.local-code.json`：

```json
{
  "provider": "",
  "model": "",
  "workspace": ".",
  "ollamaBaseUrl": "http://127.0.0.1:11434",
  "lmStudioBaseUrl": "http://127.0.0.1:1234",
  "maxSteps": 12,
  "allowCommands": false,
  "allowWrites": false,
  "allowNetwork": false,
  "temperature": 0.2
}
```

`provider` 或 `model` 留空時，程式會在啟動時互動式詢問使用者。
如果目前終端不是互動模式，程式會輸出完整的 provider 診斷摘要。
首次選完後，CLI 會把結果寫回 `.local-code.json`，下次直接沿用。

## 用法

列出可用模型：

```powershell
node ./bin/local-code.js models
node ./bin/local-code.js models --provider ollama
node ./bin/local-code.js models --provider lmstudio
```

單次執行：

```powershell
node ./bin/local-code.js run "閱讀目前專案，建立一個簡單的 express API"
```

互動模式：

```powershell
node ./bin/local-code.js chat
```

執行本機命令（編譯、測試、跑程式）：

```powershell
node ./bin/local-code.js run "編譯並執行這個 C# 專案"
```

預設不用加任何參數——模型呼叫 `run_command`（例如 `dotnet build`、`npm test`）時，會直接在終端機印出指令內容並問你 `Allow this command? [y/N]:`，按 `y` 才會真的執行。如果不是在真人操作的終端機裡執行（例如透過管道/腳本），沒有 TTY 可以問就會直接安全拒絕。

如果你完全信任這個專案、不想每次都被問，可以整個 session 跳過詢問：

```powershell
node ./bin/local-code.js run "執行測試並修正失敗案例" --allow-commands
```

同樣地，模型呼叫 `write_file`、`append_file`、`replace_in_file`、`make_directory` 這些會建立/覆寫/修改檔案或資料夾的工具時，預設也會先印出要變更的路徑（和內容預覽）並問 `Allow this change? [y/N]:`，按 `y` 才會真的寫入；沒有 TTY 時一樣直接安全拒絕。想跳過詢問可以加 `--allow-writes`：

```powershell
node ./bin/local-code.js run "幫我建立這個功能的檔案" --allow-writes
```

模型呼叫 `web_search`（查 DuckDuckGo）或 `web_fetch`（抓網頁內容）時，一樣預設會先問 `Allow this network request? [y/N]:`，按 `y` 才會真的發出連線；沒有 TTY 時直接安全拒絕。這讓模型能查到訓練資料截止日之後的新資訊（例如新版本號、近期新聞），不用只靠舊的訓練知識回答。想跳過詢問可以加 `--allow-network`：

```powershell
node ./bin/local-code.js run "幫我查一下最新的 Node.js LTS 版本" --allow-network
```

`run_command` 之外的其他工具（`list_files`、`read_file`、`search_text`）只是讀取，不會跳出詢問。每一步驟模型在做什麼、呼叫了哪個工具、帶了什麼參數，都會即時印在終端機（stderr），不會等到最後才一次顯示結果。

列出目前可用的 Skill：

```powershell
local-code skills
```

用關鍵字叫出 Skill（`run` 跟 `chat` 都支援，一開頭打 `/名稱`）：

```powershell
local-code run "/reviewer 看一下 src/agent.js 有沒有明顯 bug"
```

```powershell
local-code chat
> /skills
> /reviewer 看一下 src/agent.js 有沒有明顯 bug
```

## Skill 系統

Skill 是一份 Markdown 檔，開頭有簡單的 frontmatter，用來把「特定任務的額外指示」跟「這次任務可以用哪些工具」包成一個可重複使用、可分享的單位，類似 Claude Code 的 Skill / Slash command。

放置位置（同名時，專案層級蓋掉使用者層級）：

- 專案層級：`<workspace>/.local-code/skills/*.md` — 可以連同專案一起 commit，團隊共用
- 使用者層級：`~/.local-code/skills/*.md` — 個人跨專案共用

檔案格式，例如 `.local-code/skills/reviewer.md`：

```markdown
---
name: reviewer
description: Review code changes for bugs, risky edge cases, and style issues.
keywords: rv, code-review
tools: read_file, search_text, list_files
---

You are in "reviewer" mode for this task. Only look for bugs, risky edge
cases, and style issues. Do not modify files unless explicitly asked.
```

欄位說明：

- `name`：必填，唯一識別，也是預設觸發用的 `/名稱`
- `description`：必填，`local-code skills` 列表會顯示
- `keywords`：選填，逗號分隔的別名，一樣可以用 `/別名` 觸發
- `tools`：選填，逗號分隔的工具白名單；省略代表這次任務可以用全部工具。模型呼叫白名單以外的工具時，會收到明確的錯誤訊息（不會讓整個 CLI 崩潰），可以在剩餘步數內自行改用允許的工具

觸發方式是明確的 `/名稱` 前綴（不是讓模型自己語意判斷要不要用），對本地小型模型來說最穩定、可預期：

```powershell
local-code run "/reviewer 檢查 src/agent.js"
```

`reviewer` 開頭的指示會被組進送給模型的內容，格式類似：

```
[Skill: reviewer]
<skill 內文>

Task: 檢查 src/agent.js
```

保留字（不能拿來當 Skill 名稱或別名，會被忽略並印出警告）：`exit`、`provider`、`model`、`status`、`skills`。

`chat` 模式內也可以用 `/skills` 列出可用 Skill，或直接打 `/名稱 ...` 觸發。

## Chat 指令與記憶重置

`chat` 對話記錄會存在 `.local-code-state.json`，下次在同一個資料夾用同樣的 provider/model 開 `chat` 時會自動還原（`restored saved chat history (N turn(s))`）。

Chat 內建指令：

- `/provider` 切換 provider，同時清空記憶重新開始
- `/model` 切換 model，同時清空記憶重新開始
- `/status` 顯示目前 provider、model、workspace、記憶狀態
- `/reset` 只清空對話記憶，provider/model/workspace 都不變
- `/attach <路徑>` 讀取電腦上任何位置的檔案（不限於目前 workspace），下一則你送出的訊息會自動附上這份內容一起給模型（見下方「讀取專案以外的檔案」）
- `/skills` 列出可用 Skill
- `/exit` 離開

**什麼時候要用 `/reset`：** 對話記憶會把過去的 `<tool_result>`（包含失敗訊息）一起還原給模型。如果你升級了 `local-code`（例如修了某個工具的 bug）、或改了 `--allow-commands` 之類的設定，但這個資料夾的 chat 記憶裡還留著「舊版工具失敗」的紀錄，模型會傾向照著自己之前講過的話回答，即使新版工具其實已經能做到了，也可能還是說「我做不到」。這時候打 `/reset` 清掉舊記憶重新開始，模型才會重新嘗試。

## 任務進度 Checkpoint

跟 chat 記憶（對話逐字稿）分開，另外提供一套「任務進度」的存檔機制：記錄目標、目前狀態、已完成/待完成的步驟、背景決策、卡關點、關鍵檔案，存在同一個 `.local-code-state.json` 的 `checkpoints`欄位裡，跨資料夾重開 `chat` 或重啟電腦都還在。

存檔時會**自動從當下的對話紀錄擷取最近幾則你打過的原始 prompt**（會過濾掉 `<tool_result>` 之類的工具回傳內容，只留你自己輸入的部分），附加進 checkpoint 裡，不用自己手動回想輸入一次。

在 `chat` 內使用：

```
/checkpoint            # 互動式存檔（依序詢問目標／狀態／已完成／待辦／背景／卡關點／關鍵檔案）
/checkpoint list        # 列出所有 checkpoint
/checkpoint show [id]    # 顯示指定或目前進行中的 checkpoint 完整內容
/checkpoint complete [id] # 標記完成
```

不進 chat，直接用 CLI 也可以：

```powershell
node ./bin/local-code.js checkpoint save
node ./bin/local-code.js checkpoint list
node ./bin/local-code.js checkpoint show
node ./bin/local-code.js checkpoint complete
```

只要該資料夾還有「進行中」（未標記完成）的 checkpoint，下次執行 `local-code chat` 時會自動在最上方顯示，提醒你從待辦步驟繼續，不用自己去找。

## 讀取專案以外的檔案

預設情況下，`list_files`／`read_file`／`search_text` 都只能看到目前 workspace 根目錄底下的檔案（跟 Claude Code 一樣，會擋掉 `../` 這種跳出 workspace 的路徑）。如果想讓模型分析電腦上其他地方的檔案，有兩種方式：

- **`/attach <路徑>`（只在 `chat` 模式）**：像 Claude Code 拖檔案進來一樣，輸入絕對路徑（或相對於啟動 `local-code` 那個資料夾的相對路徑），例如：

  ```
  > /attach C:\Users\me\Desktop\error-log.txt
  attached: C:\Users\me\Desktop\error-log.txt (1234 chars) - will be sent with your next message
  > 幫我看這份 log 裡有什麼問題
  ```

  終端機會印出**解析後的絕對路徑**，讓你確認實際讀到的是哪個檔案；內容會在你送出下一則訊息時一併附上給模型，附加一次後就清空，不會重複夾帶。

- **模型主動呼叫 `read_external_file`**：如果你在對話中直接提到一個專案外的絕對路徑，模型也可以自己呼叫這個工具讀取，不需要你先手動 `/attach`。

兩種方式都是唯讀，不能寫入 workspace 以外的地方，單一檔案上限 2MB，且都會回傳（或印出）解析後的絕對路徑，方便確認讀到的是哪一份檔案。

## 背景子任務

模型可以呼叫 `spawn_agent` 把一個**跟目前任務彼此獨立**的子任務丟到背景執行（沿用同一個 workspace 與權限設定），呼叫會立刻回傳 `{id, status:"running"}`，不會卡住主流程。之後模型可以：

- `check_agent`：帶 `id` 查詢該子任務目前是 `running` / `done` / `failed`，以及完成後的結果
- `list_agents`：列出這次 session 內所有背景子任務（最新的在前面）

這是給模型自己在推理過程中決定要不要用的工具，不是給使用者手動下的指令；例如「同時檢查兩個沒有關聯的檔案」這種可以平行處理的任務，模型可能會用 `spawn_agent` 分派其中一半，自己繼續做另一半，最後再用 `check_agent` 收結果。

**併發上限：** 同時間最多只能有 `maxConcurrentAgents`（預設 `3`）個背景子任務處於 `running` 狀態，超過就直接讓 `spawn_agent` 回傳錯誤（不是排隊等待），提示模型先用 `check_agent` 收一些結果再繼續開新的。這是因為每個並行的對話請求都會在本地模型伺服器（Ollama/LM Studio）裡各自佔用一份 context/KV-cache，一次開太多平行請求容易把本地伺服器的記憶體/顯存吃爆，讓整個環境變慢甚至掛掉。可以用 `.local-code.json` 的 `maxConcurrentAgents`、`--max-concurrent-agents` 參數或看你要的方式調整這個上限。

限制（目前是最小版本）：

- 任務清單只存在記憶體裡，CLI 結束就會消失，不像 chat 記憶或 checkpoint 會落地存檔（清單本身也不會自動清除已完成的舊紀錄，長時間跑的 session 裡會持續累積）
- 子任務如果也需要寫檔/跑指令/連網的核准，一樣會跳出終端機 `[y/N]` 詢問，跟主任務的詢問可能交錯出現，是同一個共用的終端輸入
- 超過併發上限時是直接報錯而不是排隊，模型需要自己用 `check_agent` 等一個任務做完再重試

## 偵測邏輯

`Ollama`

- 先檢查 `ollama` 指令或常見安裝路徑
- 再檢查 `http://127.0.0.1:11434/api/tags`
- 如果沒有模型，會提示像 `ollama pull qwen2.5-coder:7b`

`LM Studio`

- 先檢查 `LM Studio` 常見安裝路徑或 `lms` 指令
- 再檢查 `http://127.0.0.1:1234/v1/models`
- 如果沒有模型，會提示先在 LM Studio 下載並啟用 local server

## 限制

- 目前仍是 MVP，不是完整複刻 Claude Code
- 工具呼叫仍採 prompt 協議，不是原生 function calling，本地小型模型偶爾會把大段程式碼包進 JSON 時跳脫字元出錯或被輸出長度截斷（CLI 會自動重試、多次失敗會清楚回報而不是靜默卡住，但無法保證每次都成功）
- `replace_in_file` 仍是字串替換，不是 AST 或 diff patch
- 語法檢查目前只支援 `.py`（需要系統裝有 `python`/`python3`/`py`）與 `.js`/`.mjs`（用 Node 內建 `--check`），其他副檔名不會檢查
- Skill 觸發只支援明確的 `/名稱` 前綴，沒有 Claude Code 那種依描述語意自動判斷要不要用某個 Skill 的能力
- 模型偶爾會在自然語言回答裡「宣稱」做了某件事但實際沒有呼叫工具（幻覺）；system prompt 已要求模型有實際工具結果才能宣稱成功、被問到檔案在哪要先查證，但無法 100% 杜絕，遇到可疑的回答可以直接請它用 `list_files`/`read_file` 再次確認

## Workspace 掃描的容錯處理

啟動時（例如顯示「最近修改的檔案」）會遞迴掃描 workspace 目錄。掃描邏輯會：

- 略過讀取失敗（權限不足、壞掉的 symlink 等）的檔案或資料夾，不會讓整個 CLI 崩潰
- 最多掃描 5000 個項目，避免在超大型目錄（例如整個使用者家目錄）下卡住

如果直接在很大的資料夾（如使用者家目錄）下執行，建議還是切到實際的專案子資料夾再用 `local-code`，掃描範圍較小、啟動也更快。
