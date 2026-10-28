"""Small stdlib-only Codex app-server client for the existing Termux launcher.

python termux_codex.py --probe
python termux_codex.py "用一句话解释 Python 装饰器"

Uses existing Codex configuration/login. Each prompt starts a new thread.
This is a connectivity example, not a full coding client or official SDK.
"""

import argparse
import asyncio
from collections import deque
import json
import os
import sys
import tempfile


class CodexClient:
    def __init__(self, binary="codex", timeout=180):
        self.binary = binary
        self.timeout = timeout
        self.sequence = 0
        self.events = deque()

    async def __aenter__(self):
        # Drain stderr to a temporary file so startup logs cannot block stdout.
        self.log = tempfile.TemporaryFile()
        try:
            self.process = await asyncio.create_subprocess_exec(
                self.binary, "app-server", "--listen", "stdio://",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=self.log,
                limit=8 * 1024 * 1024,
            )
        except BaseException:
            self.log.close()
            raise
        try:
            self.info = await self.request("initialize", {
                "clientInfo": {"name": "termux_python", "version": "0.1.0"},
            })
            await self.send({"method": "initialized", "params": {}})
        except BaseException:
            await self.__aexit__(None, None, None)
            raise
        return self

    async def __aexit__(self, *_):
        try:
            if self.process.returncode is None:
                self.process.stdin.close()
                try:
                    await asyncio.wait_for(self.process.wait(), 5)
                except TimeoutError:
                    self.process.terminate()
                    try:
                        await asyncio.wait_for(self.process.wait(), 5)
                    except TimeoutError:
                        self.process.kill()
                        await self.process.wait()
        finally:
            self.log.close()

    async def send(self, message):
        self.process.stdin.write((json.dumps(message) + "\n").encode())
        await self.process.stdin.drain()

    async def receive(self):
        raw = await self.process.stdout.readline()
        if not raw:
            raise RuntimeError("Codex app-server closed its output unexpectedly")
        return json.loads(raw)

    async def handle_request(self, message):
        method = message["method"]
        if method in (
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
        ):
            await self.send({"id": message["id"], "result": {"decision": "decline"}})
        else:
            await self.send({"id": message["id"], "error": {
                "code": -32601, "message": "Not implemented by this demo client",
            }})

    async def request(self, method, params):
        # This minimal client supports one outstanding client request at a time.
        self.sequence += 1
        request_id = self.sequence
        async with asyncio.timeout(self.timeout):
            await self.send({"id": request_id, "method": method, "params": params})
            while True:
                message = await self.receive()
                if "method" in message and "id" in message:
                    await self.handle_request(message)
                elif message.get("id") == request_id:
                    if "error" in message:
                        raise RuntimeError(json.dumps(message["error"], ensure_ascii=False))
                    return message["result"]
                else:
                    self.events.append(message)

    async def probe(self):
        print("App Server 握手成功", flush=True)
        print("运行时:", self.info.get("userAgent"), flush=True)
        result = await self.request("model/list", {"limit": 5})
        print("模型目录:", ", ".join(m["id"] for m in result.get("data", [])), flush=True)
        result = await self.request("account/read", {"refreshToken": False})
        account = result.get("account")
        print("登录类型:", account.get("type") if account else "无账户信息", flush=True)

    async def run(self, prompt, model=None):
        params = {"cwd": os.getcwd(), "sandbox": "read-only", "approvalPolicy": "never"}
        if model:
            params["model"] = model
        thread = await self.request("thread/start", params)
        thread_id = thread["thread"]["id"]
        print("会话:", thread_id, file=sys.stderr, flush=True)
        streamed = set()
        async with asyncio.timeout(self.timeout):
            result = await self.request("turn/start", {
                "threadId": thread_id,
                "input": [{"type": "text", "text": prompt}],
            })
            turn_id = result["turn"]["id"]
            while True:
                message = self.events.popleft() if self.events else await self.receive()
                if "method" in message and "id" in message:
                    await self.handle_request(message)
                    continue
                event = message.get("method")
                data = message.get("params", {})
                if data.get("threadId") != thread_id:
                    continue
                if event == "item/agentMessage/delta":
                    streamed.add(data.get("itemId"))
                    print(data.get("delta", ""), end="", flush=True)
                elif event == "item/completed":
                    item = data.get("item", {})
                    if item.get("type") == "agentMessage":
                        if item.get("id") not in streamed:
                            print(item.get("text", ""), end="", flush=True)
                        print(flush=True)
                elif event == "turn/completed" and data["turn"]["id"] == turn_id:
                    turn = data["turn"]
                    if turn["status"] != "completed":
                        raise RuntimeError(json.dumps(turn.get("error") or turn["status"], ensure_ascii=False))
                    return


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", nargs="?")
    parser.add_argument("--probe", action="store_true", help="Only check local connectivity and account metadata")
    parser.add_argument("--codex-bin", default="codex")
    parser.add_argument("--model", help="Defaults to the existing Codex configuration")
    parser.add_argument("--timeout", type=float, default=180)
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    async with CodexClient(args.codex_bin, args.timeout) as client:
        if args.probe or not args.prompt:
            await client.probe()
        if args.prompt:
            await client.run(args.prompt, args.model)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except (OSError, RuntimeError, TimeoutError) as error:
        print(f"错误: {error or '请求超时'}", file=sys.stderr)
        sys.exit(1)
