# ASR —— DSH Hub 的本机语音识别服务（WP49）

手机 App「按住说话」不再依赖 Android 系统 `SpeechRecognizer`（国产 ROM 上第三方不可用，一按就
`ERROR_CLIENT`）。App 自己录 16kHz / 单声道 / 16bit WAV，上传到 Hub 的 `POST /api/mobile/asr`，
Hub 转发给**本机**这个服务转文字；识别只占 CPU，GPU 留给用户的语音服务。

```
App ──audio/wav──▶ Hub (:7700 /api/mobile/asr) ──HTTP──▶ dsh-asr (127.0.0.1:9890) ──▶ SenseVoice int8
```

## 目录

| 文件 | 用途 |
| --- | --- |
| `server.py` | HTTP 服务（标准库）+ sherpa-onnx SenseVoice 推理；常驻、单进程 |
| `requirements.txt` | `sherpa-onnx==2.0.1`、`numpy==2.5.4`（实测版本） |
| `install.sh` | 幂等安装：venv → 模型（sha256 校验）→ 拷代码 → systemd 单元 → 健康检查 |
| `dsh-asr.service` | systemd **用户**单元模板（`@ASR_HOME@` / `@PORT@` 由 install.sh 渲染） |

数据目录（默认 `~/.local/share/dsh-asr`）：

```
venv/            uv 建的独立 Python 3.12 环境
models/<模型名>/ model.int8.onnx + tokens.txt（约 230MB）
app/server.py    安装后的代码（单元不引用 git 仓库路径）
download/        模型压缩包（保留，重装不重下）
logs/            手动前台运行时的日志（systemd 走 journal）
```

## 安装

前置：`uv`（`~/.local/bin/uv`）、`curl`、`tar`。安装脚本会先 `unset` 代理变量
（模型与 pip 包默认走国内可用的镜像，墙外可删掉脚本里那几行镜像设置）。

```bash
cd <repo>
bash services/asr/install.sh
```

脚本最后会轮询 `/health` 直到就绪，并打印健康 JSON。常用覆盖：

```bash
DSH_ASR_HOME=/path/to/data  DSH_ASR_PORT=9890  bash services/asr/install.sh
DSH_ASR_SKIP_SYSTEMD=1      # 只装 venv/模型/代码（沙箱/CI），不碰 systemd
```

卸载：

```bash
systemctl --user disable --now dsh-asr
rm -f ~/.config/systemd/user/dsh-asr.service
systemctl --user daemon-reload
# 数据与模型（可选）：rm -rf ~/.local/share/dsh-asr
```

## 接口

### `GET /health`

```json
{"ok": true, "service": "dsh-asr", "version": "0.1.0", "ready": true, "language": "zh",
 "model": "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
 "maxConcurrency": 2, "numThreads": 2, "timeoutSeconds": 20.0, "uptimeSec": 12.3, "rssMb": 392.4}
```

Hub 用 `ok` 判断 `bootstrap.voice.asr`（30 秒缓存）。

### `POST /transcribe?lang=zh`（body 是 WAV 字节）

- Content-Type 不校验（Hub 已校验 `audio/wav`），但 WAV 必须是 **16kHz / 单声道 / 16bit PCM**；
- `lang`：`zh`（默认）/ `auto` / `en` / `yue` / `ja` / `ko`；
- 成功：`200 {"text": "...", "durationMs": 5000}`（`durationMs` 是**音频时长**，不是耗时）；
- 空音频：`200 {"text": "", "durationMs": 0}`；
- 失败：`400`（不是 WAV / 采样率/声道/位深不对 / 超时长）、`413`（body > 2MiB）、
  `429`（并发排满）、`504`（单次推理超过 20 秒）、`500`（推理异常）。

```bash
curl -s http://127.0.0.1:9890/health

# 模型自带的公开中文样本（5.6 秒）
M=~/.local/share/dsh-asr/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17
curl -s -X POST --data-binary @"$M/test_wavs/zh.wav" \
  'http://127.0.0.1:9890/transcribe?lang=zh'
# {"text":"开饭时间早上9点至下午5点。","durationMs":5592}
```

## 设计要点

- **一个识别器常驻**：启动即加载（冷启动 1.4 秒），之后每个请求只建 stream；进程 RSS 实测
  空闲 335MB、30 秒音频后 ~420MB、反复 60 秒音频稳定在 ~560MB（目标 < 600MB，单元 `MemoryMax=1G`）。
  每次推理后 `malloc_trim` 把激活内存还给 OS，长音频不会把 RSS 越推越高。
- **并发上限 2**：内部 `ThreadPoolExecutor(2)` + 信号量；第 3 个请求最多排队 2 秒，仍无空位回 429。
- **单次超时 20 秒**：`future.result(timeout=20)`；超时回 504，推理在后台跑完再释放槽位。
- **语言切换**：SenseVoice 的语言是**建图参数**（不是逐句参数）。`?lang` 与当前识别器不同时，
  服务会排空在跑的推理、释放旧模型再重建（约 1 秒），内存里始终只有一份 230MB 权重。
  默认 `zh`，正常使用不会触发；连续切换 6 种语言 RSS 不随次数增长（`malloc_trim` + 先释放后重建）。
- **隐私**：不落盘音频、不记录识别文字；日志只有 `bytes / durationMs / lang / status / ms / chars`。
- **只绑回环**：默认 `127.0.0.1:9890`，手机不直连，必须经 Hub 设备令牌 + 限流。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_ASR_HOME` | `~/.local/share/dsh-asr` | 数据目录（模型在 `<home>/models`） |
| `DSH_ASR_HOST` / `DSH_ASR_PORT` | `127.0.0.1` / `9890` | 监听地址 |
| `DSH_ASR_LANG` | `zh` | 启动时预加载的语言 |
| `DSH_ASR_NUM_THREADS` | `2` | 每个识别器的 onnxruntime 线程数 |
| `DSH_ASR_CONCURRENCY` | `2` | 并发上限 |
| `DSH_ASR_TIMEOUT_SECONDS` | `20` | 单次识别超时 |
| `DSH_ASR_QUEUE_WAIT_SECONDS` | `2` | 拿不到槽位时排队多久 |
| `DSH_ASR_MAX_BYTES` / `DSH_ASR_MAX_SECONDS` | `2097152` / `60` | 服务侧上限（Hub 侧另有契约上限） |

## 依赖与许可

- **推理引擎**：[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)，**Apache-2.0**（`requirements.txt` 里固定版本）。
- **模型**：[SenseVoice](https://github.com/FunAudioLLM/SenseVoice)（`sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8`，
  中/英/日/韩/粤 int8 量化版）。
- **模型权重不进仓库**：`install.sh` 会从上游 release 下载压缩包并按 sha256 校验（镜像可用
  `DSH_ASR_MODEL_MIRROR` 覆盖，pip 源用 `PIP_INDEX`）；把权重预先放到
  `$DSH_ASR_HOME/models/<模型名>/` 下时脚本会自动跳过下载。**下载、部署与商用前请自己确认模型的
  许可与使用条款**（以 SenseVoice 上游仓库与其模型发布页为准），本仓库只提供调用它的服务代码。

## 模型

- `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`
- 来源：<https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2>
- 压缩包 sha256（与 GitHub release API 的 asset digest 一致）：
  `7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e`
- `model.int8.onnx` sha256：`c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51`
- `use_itn=True`（带标点与数字规范化）。

## 实测（WSL2 / 24 核 / CPU / `num_threads=2`）

| 项目 | 结果 |
| --- | --- |
| 冷启动（进程启动 → `/health` 就绪） | 1.4 秒（其中模型加载 1.2 秒） |
| 常驻 RSS（空闲） | 335 MB |
| 常驻 RSS（跑过 30 秒音频） | ~420 MB |
| 常驻 RSS（反复 60 秒音频，稳定峰值） | ~560 MB（每次推理后 `malloc_trim`，不随次数增长） |
| 连续切换 6 种语言 | 384–432 MB（始终只有一份权重） |
| 5.0 秒中文音频 | 0.17–0.18 秒（RTF ≈ 0.035） |
| 30.0 秒中文音频 | 1.14–1.25 秒（RTF ≈ 0.04） |
| 60.0 秒中文音频（单条） | 3.2–3.4 秒（RTF ≈ 0.055） |
| 60.0 秒音频（并发 2 条） | 4.5–4.6 秒（共享 CPU） |
| 并发 6 × 60 秒 | 2 条 200、4 条 429（队列上限生效） |

准确率冒烟（CPU、`lang=zh`、`use_itn=True`）：

| 音频 | 识别结果 |
| --- | --- |
| 模型自带 `zh.wav`（公开样本，5.6s） | 开饭时间早上9点至下午5点。 |
| FunASR 公开样本 `asr_example_zh.wav`（5.5s，真人） | 欢迎大家来体验达摩院推出的语音识别模型。 |
| 本机 TTS 样本 04_long（8.1s） | 我最近在减脂，晚上不缺主食，所以你不老拿好吃的来诱惑我，我扛不住的。 |
| `en.wav`（`lang=en`） | The tribal chieftain called for the boy and presented him with 50 pieces of code. |
| `yue.wav`（`lang=yue`） | 呢几个字都表达唔到我想讲嘅意思。 |
| `ja.wav` / `ko.wav` | 日/韩语样本均正确转写（实测） |

## 故障排查

```bash
systemctl --user status dsh-asr
journalctl --user -u dsh-asr -n 100 --no-pager
curl -s http://127.0.0.1:9890/health
ss -ltnp | grep 9890          # 端口被占：改 DSH_ASR_PORT 并同步 Hub 的 HUB_ASR_URL
```

- `找不到 SenseVoice 模型`：重跑 `install.sh`（会补模型）。
- `429 BUSY`：并发 2 已满（Hub 侧每分钟 20 次/每天 600 次另算），稍后重试。
- `504 TIMEOUT`：60 秒音频正常 1–2 秒；持续超时说明 CPU 被别的任务占满。
- 内存超 1G 被 systemd 杀：看 `/health.rssMb`，正常应 < 500MB。
