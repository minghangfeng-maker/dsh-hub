#!/usr/bin/env python3
"""DSH ASR —— 本机 SenseVoice-Small(int8) 语音识别 HTTP 服务（WP49）。

与 `apps/api` 的 `POST /api/mobile/asr` 配套：手机录音（16kHz/单声道/16bit WAV）由 Hub
转发到这里转文字。设计约束：

* **只监听回环**（默认 127.0.0.1:9890），不直接暴露给手机；
* 一个常驻进程、**一个**识别器（SenseVoice int8 权重约 230MB），进程 RSS 目标 < 600MB；
* 并发上限默认 2（第 3 个请求排队 2 秒仍无空位则 429），单次识别超时 20 秒（504）；
* 语言是 SenseVoice 的**建图参数**（不是逐句参数）：`?lang=` 与当前识别器不同时重建
  识别器（先排空在跑的推理，内存里始终只有一份模型）；默认 zh，正常使用不会触发重建；
* **不记录识别文字、不落盘音频**；日志只有字节数、时长、耗时、状态码。

依赖：sherpa-onnx、numpy（HTTP 用标准库）。模型：
`sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`（ModelScope/GitHub release）。
"""

from __future__ import annotations

import argparse
import gc
import io
import json
import os
import re
import signal
import sys
import threading
import time
import wave
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
import sherpa_onnx

SERVICE_VERSION = "0.1.0"
MODEL_NAME = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
SAMPLE_RATE = 16_000
LANGS = ("zh", "auto", "en", "yue", "ja", "ko")
DEFAULT_HOME = Path(os.environ.get("DSH_ASR_HOME", str(Path.home() / ".local/share/dsh-asr")))
DEFAULT_PORT = int(os.environ.get("DSH_ASR_PORT", "9890"))
DEFAULT_HOST = os.environ.get("DSH_ASR_HOST", "127.0.0.1")
DEFAULT_LANG = os.environ.get("DSH_ASR_LANG", "zh")
DEFAULT_MAX_BYTES = int(os.environ.get("DSH_ASR_MAX_BYTES", str(2 * 1024 * 1024)))
DEFAULT_MAX_SECONDS = int(os.environ.get("DSH_ASR_MAX_SECONDS", "60"))
DEFAULT_CONCURRENCY = int(os.environ.get("DSH_ASR_CONCURRENCY", "2"))
DEFAULT_TIMEOUT = float(os.environ.get("DSH_ASR_TIMEOUT_SECONDS", "20"))
DEFAULT_QUEUE_WAIT = float(os.environ.get("DSH_ASR_QUEUE_WAIT_SECONDS", "2"))
DEFAULT_NUM_THREADS = int(os.environ.get("DSH_ASR_NUM_THREADS", "2"))

_TAG_RE = re.compile(r"<\|[^|]*\|>")


def log(message: str) -> None:
    """stderr 单行日志（systemd journal 直接可读）；绝不打印识别文字。"""
    sys.stderr.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} dsh-asr {message}\n")
    sys.stderr.flush()


def rss_mb() -> float | None:
    try:
        with open("/proc/self/status", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("VmRSS:"):
                    return round(int(line.split()[1]) / 1024, 1)
    except OSError:
        pass
    return None


def malloc_trim() -> None:
    """把 free 掉的堆还给 OS（glibc）。onnxruntime 释放权重后 RSS 不会自己降，
    语言切换会重建模型，不 trim 的话连续切换会把常驻内存推高到 1G（实测）。"""
    try:
        import ctypes

        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:  # noqa: BLE001 —— 非 glibc 平台没有这个符号，忽略
        pass


class BadAudio(Exception):
    """WAV 不合法 → 400。"""


class EngineBusy(Exception):
    """并发排空失败 → 503。"""


def resolve_model_dir(explicit: str | None, home: Path) -> Path:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    candidates.append(home / "models" / MODEL_NAME)
    models_root = home / "models"
    if models_root.is_dir():
        for child in sorted(models_root.iterdir()):
            if (child / "model.int8.onnx").is_file():
                candidates.append(child)
    for candidate in candidates:
        if (candidate / "model.int8.onnx").is_file() and (candidate / "tokens.txt").is_file():
            return candidate
    raise SystemExit(
        f"找不到 SenseVoice 模型（model.int8.onnx + tokens.txt）：{candidates}；"
        f"先跑 services/asr/install.sh"
    )


class Engine:
    """识别器 + 并发控制。

    并发语义：
    * 每个请求先拿一个 permit（最多 `concurrency` 个同时推理）；
    * 语言切换时，当前调用者已经持有一个 permit，再拿一个即可保证没有别的推理在跑，
      然后重建识别器 —— 内存里始终只有一份 230MB 的权重。
    """

    def __init__(self, model_dir: Path, *, concurrency: int, num_threads: int, timeout: float,
                 queue_wait: float, preload_lang: str) -> None:
        self._model_dir = model_dir
        self._num_threads = num_threads
        self._timeout = timeout
        self._queue_wait = queue_wait
        self._capacity = concurrency
        self._sem = threading.BoundedSemaphore(concurrency)
        self._build_lock = threading.Lock()
        self._rec = None
        self._lang: str | None = None
        self._pool = ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="asr")
        self._started = time.time()
        # 启动即加载：第一个请求不用等模型
        self.ensure_language(preload_lang)
        log(f"preload done lang={preload_lang} rss={rss_mb()}MB")

    # ── 识别器 ────────────────────────────────────────────────────────────

    def _build(self, lang: str):
        started = time.time()
        recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(self._model_dir / "model.int8.onnx"),
            tokens=str(self._model_dir / "tokens.txt"),
            num_threads=self._num_threads,
            use_itn=True,
            language=lang,
            provider="cpu",
            debug=False,
        )
        log(f"recognizer loaded lang={lang} in {time.time() - started:.2f}s rss={rss_mb()}MB")
        return recognizer

    def ensure_language(self, lang: str):
        # 注意：这里**不能**先把 self._rec 存进局部变量再做重建判断 —— 局部引用会让旧模型
        # 在新模型加载期间一直活着（两份 230MB 权重），onnxruntime 的 allocator 随后不会
        # 把这块地还给 OS：连续切换语言实测把 RSS 从 340MB 推到 880MB。
        if self._rec is not None and self._lang == lang:
            return self._rec
        with self._build_lock:
            if self._rec is not None and self._lang == lang:
                return self._rec
            drained = False
            if self._rec is not None and self._capacity >= 2:
                # 已经有一个 permit 被本次请求持有；再拿一个 = 没有其它推理在跑
                drained = self._sem.acquire(timeout=self._timeout)
                if not drained:
                    raise EngineBusy("识别服务忙，等不到空闲槽位")
                log(f"language switch {self._lang} -> {lang}，重建识别器")
            try:
                # 先释放旧识别器再建新的：两份 230MB 权重同时在世时 onnxruntime 的
                # allocator 会留下大块空地，连续切换语言实测推到 900MB+。
                if self._rec is not None:
                    self._rec = None
                    self._lang = None
                    gc.collect()
                    malloc_trim()
                self._rec = self._build(lang)
                self._lang = lang
            finally:
                if drained:
                    self._sem.release()
            return self._rec

    # ── 推理 ──────────────────────────────────────────────────────────────

    def transcribe(self, samples: np.ndarray, lang: str) -> tuple[int, str]:
        if not self._sem.acquire(timeout=self._queue_wait):
            raise EngineBusy("识别服务忙，请稍后再试")

        released = threading.Event()

        def release_once() -> None:
            if not released.is_set():
                released.set()
                self._sem.release()

        future = self._pool.submit(self._decode, samples, lang)
        future.add_done_callback(lambda _f: release_once())
        try:
            text = future.result(timeout=self._timeout)
            return 0, text
        except FutureTimeout:
            log(f"timeout after {self._timeout:.0f}s（推理继续跑完，槽位随后释放）")
            return 504, ""
        except EngineBusy:
            raise
        except Exception as exc:  # noqa: BLE001 —— 识别失败一律 500，细节进日志
            log(f"decode failed: {type(exc).__name__}: {exc}")
            return 500, ""
        finally:
            if future.done():
                release_once()

    def _decode(self, samples: np.ndarray, lang: str) -> str:
        recognizer = self.ensure_language(lang)
        stream = recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, samples)
        try:
            recognizer.decode_stream(stream)
            return _TAG_RE.sub("", stream.result.text).strip()
        finally:
            # 60 秒音频的激活峰值约 200MB；不还给 OS 的话连续长音频会把常驻 RSS 推到
            # 650MB+（实测）。每次推理后 trim 一次，稳定在 ~450MB，代价是几毫秒。
            del stream
            malloc_trim()

    def stats(self) -> dict[str, object]:
        return {
            "ready": self._rec is not None,
            "language": self._lang,
            "model": self._model_dir.name,
            "maxConcurrency": self._capacity,
            "numThreads": self._num_threads,
            "timeoutSeconds": self._timeout,
            "uptimeSec": round(time.time() - self._started, 1),
            "rssMb": rss_mb(),
        }

    def dispose(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)


def parse_wav(data: bytes, *, max_seconds: int) -> tuple[np.ndarray, int]:
    """校验并解码 WAV：必须是 16kHz / 单声道 / 16bit PCM。返回 (float32 样本, 毫秒)。"""
    if len(data) < 44 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise BadAudio("不是 RIFF/WAVE 文件")
    try:
        with wave.open(io.BytesIO(data), "rb") as reader:
            channels = reader.getnchannels()
            width = reader.getsampwidth()
            rate = reader.getframerate()
            frames = reader.getnframes()
            payload = reader.readframes(frames)
    except (wave.Error, EOFError) as exc:
        raise BadAudio(f"WAV 解析失败：{exc}") from exc
    if channels != 1:
        raise BadAudio(f"只支持单声道（收到 {channels} 声道）")
    if width != 2:
        raise BadAudio(f"只支持 16bit PCM（收到 {width * 8}bit）")
    if rate != SAMPLE_RATE:
        raise BadAudio(f"只支持 {SAMPLE_RATE}Hz（收到 {rate}Hz）")
    if len(payload) != frames * 2:
        raise BadAudio("WAV 数据不完整")
    duration_ms = int(round(frames * 1000 / rate))
    if duration_ms > max_seconds * 1000:
        raise BadAudio(f"音频超过 {max_seconds} 秒")
    if frames == 0:
        return np.zeros(0, dtype=np.float32), 0
    samples = np.frombuffer(payload, dtype=np.int16).astype(np.float32) / 32768.0
    return samples, duration_ms


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"dsh-asr/{SERVICE_VERSION}"
    sys_version = ""
    timeout = 30  # 慢连接不要占着线程

    # 注入：main() 里赋给 ThreadingHTTPServer 的实例属性
    engine: Engine
    max_bytes: int
    max_seconds: int

    def log_message(self, fmt: str, *args: object) -> None:  # noqa: D401 —— 关掉默认访问日志
        return

    # ── 响应 ──────────────────────────────────────────────────────────────

    def _send(self, status: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _error(self, status: int, code: str, message: str) -> None:
        self._send(status, {"error": {"code": code, "message": message}})

    # ── 路由 ──────────────────────────────────────────────────────────────

    def do_GET(self) -> None:  # noqa: N802 —— BaseHTTPRequestHandler 的约定
        path = urlparse(self.path).path
        if path == "/health":
            self._send(200, {"ok": True, "service": "dsh-asr", "version": SERVICE_VERSION, **self.engine.stats()})
            return
        self._error(404, "NOT_FOUND", "只有 GET /health 与 POST /transcribe")

    def do_POST(self) -> None:  # noqa: N802
        started = time.time()
        path = urlparse(self.path).path
        if path != "/transcribe":
            self._error(404, "NOT_FOUND", "只有 GET /health 与 POST /transcribe")
            return

        query = parse_qs(urlparse(self.path).query)
        lang = (query.get("lang") or [DEFAULT_LANG])[0]
        if lang not in LANGS:
            self._error(400, "VALIDATION_FAILED", f"lang 只能是 {'/'.join(LANGS)}")
            return

        length_header = self.headers.get("Content-Length")
        try:
            length = int(length_header) if length_header is not None else -1
        except ValueError:
            length = -1
        if length <= 0:
            self._error(400, "VALIDATION_FAILED", "缺少 Content-Length 或请求体为空")
            return
        if length > self.max_bytes:
            self.close_connection = True
            self._error(413, "PAYLOAD_TOO_LARGE", f"音频超过 {self.max_bytes} 字节")
            return

        body = self.rfile.read(length)
        if len(body) != length:
            self._error(400, "VALIDATION_FAILED", "请求体不完整")
            return

        try:
            samples, duration_ms = parse_wav(body, max_seconds=self.max_seconds)
        except BadAudio as exc:
            log(f"bad wav bytes={length} {exc}")
            self._error(400, "VALIDATION_FAILED", str(exc))
            return

        if duration_ms == 0:
            log(f"empty audio bytes={length} lang={lang} status=200 ms={(time.time() - started) * 1000:.1f}")
            self._send(200, {"text": "", "durationMs": 0})
            return

        try:
            status, text = self.engine.transcribe(samples, lang)
        except EngineBusy as exc:
            log(f"busy bytes={length} lang={lang} status=429")
            self._error(429, "BUSY", str(exc))
            return

        elapsed_ms = round((time.time() - started) * 1000, 1)
        if status != 0:
            code = "TIMEOUT" if status == 504 else "INTERNAL"
            message = "识别超时" if status == 504 else "识别失败"
            log(f"bytes={length} durationMs={duration_ms} lang={lang} status={status} ms={elapsed_ms}")
            self._error(status, code, message)
            return
        log(f"bytes={length} durationMs={duration_ms} lang={lang} status=200 ms={elapsed_ms} chars={len(text)}")
        self._send(200, {"text": text, "durationMs": duration_ms})


def build_server(args: argparse.Namespace, engine: Engine) -> ThreadingHTTPServer:
    handler = type(
        "BoundHandler",
        (Handler,),
        {"engine": engine, "max_bytes": args.max_bytes, "max_seconds": args.max_seconds},
    )
    server = ThreadingHTTPServer((args.host, args.port), handler)
    server.daemon_threads = True
    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="DSH ASR：SenseVoice 本机识别服务")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--home", default=str(DEFAULT_HOME), help="数据目录（模型在 <home>/models）")
    parser.add_argument("--model-dir", default=os.environ.get("DSH_ASR_MODEL_DIR"))
    parser.add_argument("--lang", default=DEFAULT_LANG, choices=LANGS)
    parser.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY)
    parser.add_argument("--num-threads", type=int, default=DEFAULT_NUM_THREADS)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("--queue-wait", type=float, default=DEFAULT_QUEUE_WAIT)
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    parser.add_argument("--max-seconds", type=int, default=DEFAULT_MAX_SECONDS)
    args = parser.parse_args(argv)

    home = Path(args.home).expanduser()
    model_dir = resolve_model_dir(args.model_dir, home)
    engine = Engine(
        model_dir,
        concurrency=args.concurrency,
        num_threads=args.num_threads,
        timeout=args.timeout,
        queue_wait=args.queue_wait,
        preload_lang=args.lang,
    )
    server = build_server(args, engine)
    log(
        f"listening http://{args.host}:{args.port} model={model_dir.name} "
        f"lang={args.lang} concurrency={args.concurrency} threads={args.num_threads} rss={rss_mb()}MB"
    )

    def stop(_signum: int, _frame: object) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
        engine.dispose()
        log("stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
